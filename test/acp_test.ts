import { createAcpServer } from '../src/acp.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { join } from 'node:path'
import { RuntimeEventLog } from '../src/runtime/index.ts'
import { HookEngine } from '../src/hook/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly captured: ChatMessage[][] = []

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    this.captured.push([..._messages])
    yield { type: 'done' }
  }
}

class BlockingProvider implements Provider {
  readonly protocol = 'openai' as const
  aborted = false

  async *streamChat(_messages: ChatMessage[], opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: 'started' }
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve()
      const timer = setTimeout(resolve, 2000)
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
    this.aborted = opts.signal?.aborted ?? false
  }
}

const root = join(import.meta.dirname, 'fixtures_acp')
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const runtimeEvents = new RuntimeEventLog(join(root, 'runtime'))
const provider = new FakeProvider()
const hooks = new HookEngine([
  { event: 'session_start', action: { type: 'inject_prompt', content: 'ACP 会话启动提示' } },
  { event: 'round_end', action: { type: 'inject_prompt', content: 'ACP 上次执行已结束' } },
])
const server = createAcpServer({
  provider,
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  authToken: 'secret',
  maxSessions: 1,
  sessionTtlMs: 60_000,
  contextWindow: 4096,
  runtimeEvents,
  sessionId: 'acp-audit-test',
  hooks,
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('ACP server 未监听')
const base = `http://127.0.0.1:${address.port}`

const unauthorized = await fetch(`${base}/health`)
if (unauthorized.status !== 401) throw new Error('ACP 未拦截未授权请求')

const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
const created = await fetch(`${base}/session/new`, { method: 'POST', headers })
if (!created.ok) throw new Error(`ACP 创建会话失败: ${created.status}`)
const session = await created.json() as { sessionId?: string }
if (!session.sessionId) throw new Error('ACP sessionId 缺失')
if (!runtimeEvents.read('acp-audit-test').some((event) => event.type === 'audit' && event.payload?.kind === 'acp_session_created')) {
  throw new Error('ACP 会话审计事件缺失')
}

const prompt = await fetch(`${base}/session/${session.sessionId}/prompt`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'context budget' }),
})
await prompt.text()
if (!provider.captured.some((messages) => messages.some((message) => message.content === 'ACP 会话启动提示'))) {
  throw new Error('ACP session_start 注入未进入首个模型请求')
}
const secondPrompt = await fetch(`${base}/session/${session.sessionId}/prompt`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'second prompt' }),
})
await secondPrompt.text()
if (!provider.captured[1]?.some((message) => message.content === 'ACP 上次执行已结束')) {
  throw new Error('ACP round_end 注入未进入下一次模型请求')
}
const budgetEvent = runtimeEvents.read('acp-audit-test').find((event) => event.type === 'context_snapshot')
if (budgetEvent?.payload?.window !== 4096) throw new Error('ACP 未接入公共上下文预算')

engine.addSessionRule({ tool: 'run_command', pattern: 'echo scoped', action: 'allow' }, session.sessionId)
const replacementResponse = await fetch(`${base}/session/new`, { method: 'POST', headers })
const replacement = await replacementResponse.json() as { sessionId?: string }
if (!replacementResponse.ok || !replacement.sessionId || replacement.sessionId === session.sessionId) throw new Error('ACP 未回收最久空闲会话')
if (engine.match({ name: 'run_command', args: { command: 'echo scoped' } }, session.sessionId)) {
  throw new Error('ACP 回收空闲会话后仍保留权限规则')
}
const evictedPrompt = await fetch(`${base}/session/${session.sessionId}/prompt`, { method: 'POST', headers, body: JSON.stringify({ text: 'evicted' }) })
if (evictedPrompt.status !== 404) throw new Error('ACP 被回收会话仍可继续执行')

engine.addSessionRule({ tool: 'run_command', pattern: 'echo scoped', action: 'allow' }, replacement.sessionId)
const closedResponse = await fetch(`${base}/session/${replacement.sessionId}/close`, { method: 'POST', headers })
if (closedResponse.status !== 200) throw new Error(`ACP 空闲会话关闭失败: ${closedResponse.status}`)
if (engine.match({ name: 'run_command', args: { command: 'echo scoped' } }, replacement.sessionId)) {
  throw new Error('ACP 关闭会话后仍保留权限规则')
}
const closedAgain = await fetch(`${base}/session/${replacement.sessionId}/close`, { method: 'POST', headers })
if (closedAgain.status !== 404) throw new Error('ACP 重复关闭不存在会话未返回 404')
const freshResponse = await fetch(`${base}/session/new`, { method: 'POST', headers })
const fresh = await freshResponse.json() as { sessionId?: string }
if (!freshResponse.ok || !fresh.sessionId) throw new Error('ACP 关闭后未释放会话额度')
engine.addSessionRule({ tool: 'run_command', pattern: 'echo scoped', action: 'allow' }, fresh.sessionId)
server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
await new Promise((resolve) => setImmediate(resolve))
if (engine.match({ name: 'run_command', args: { command: 'echo scoped' } }, fresh.sessionId)) {
  throw new Error('ACP 服务关闭后仍保留会话权限规则')
}

const lruServer = createAcpServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  authToken: 'secret',
  maxSessions: 2,
})
await new Promise<void>((resolve, reject) => {
  lruServer.once('error', reject)
  lruServer.listen(0, '127.0.0.1', resolve)
})
const lruAddress = lruServer.address()
if (!lruAddress || typeof lruAddress === 'string') throw new Error('ACP LRU server 未监听')
const lruBase = `http://127.0.0.1:${lruAddress.port}`
const createLruSession = async (): Promise<string> => {
  const response = await fetch(`${lruBase}/session/new`, { method: 'POST', headers })
  const data = await response.json() as { sessionId?: string }
  if (!response.ok || !data.sessionId) throw new Error('ACP LRU 会话创建失败')
  return data.sessionId
}
const firstLruId = await createLruSession()
const secondLruId = await createLruSession()
const refreshed = await fetch(`${lruBase}/session/${firstLruId}/prompt`, {
  method: 'POST', headers, body: JSON.stringify({ text: 'refresh LRU' }),
})
await refreshed.text()
await createLruSession()
const oldLruPrompt = await fetch(`${lruBase}/session/${secondLruId}/prompt`, {
  method: 'POST', headers, body: JSON.stringify({ text: 'old' }),
})
if (oldLruPrompt.status !== 404) throw new Error('ACP 未优先回收最久未使用的空闲会话')
const refreshedPrompt = await fetch(`${lruBase}/session/${firstLruId}/prompt`, {
  method: 'POST', headers, body: JSON.stringify({ text: 'still alive' }),
})
if (!refreshedPrompt.ok) throw new Error('ACP 误回收最近使用的会话')
await refreshedPrompt.text()
lruServer.closeAllConnections()
await new Promise<void>((resolve, reject) => lruServer.close((error) => error ? reject(error) : resolve()))

let signalInitStarted!: () => void
let releaseInit!: () => void
const initStarted = new Promise<void>((resolve) => { signalInitStarted = resolve })
const initGate = new Promise<void>((resolve) => { releaseInit = resolve })
const initHooks = new HookEngine([])
const originalInitFire = initHooks.fire.bind(initHooks)
initHooks.fire = async (event, context) => {
  if (event === 'session_start') {
    signalInitStarted()
    await initGate
  }
  await originalInitFire(event, context)
}
const initServer = createAcpServer({
  provider: new FakeProvider(), registry: new ToolRegistry(), engine, cwd: process.cwd(),
  authToken: 'secret', maxSessions: 1, hooks: initHooks,
})
await new Promise<void>((resolve, reject) => {
  initServer.once('error', reject)
  initServer.listen(0, '127.0.0.1', resolve)
})
const initAddress = initServer.address()
if (!initAddress || typeof initAddress === 'string') throw new Error('ACP initializing server 未监听')
const initBase = `http://127.0.0.1:${initAddress.port}`
const firstInitRequest = fetch(`${initBase}/session/new`, { method: 'POST', headers })
await initStarted
const secondInitResponse = await fetch(`${initBase}/session/new`, { method: 'POST', headers })
if (secondInitResponse.status !== 429) throw new Error('ACP 初始化中的会话被并发请求回收')
releaseInit()
const firstInitResponse = await firstInitRequest
const firstInit = await firstInitResponse.json() as { sessionId?: string }
if (!firstInitResponse.ok || !firstInit.sessionId) throw new Error('ACP 并发创建后首个会话失败')
const initPrompt = await fetch(`${initBase}/session/${firstInit.sessionId}/prompt`, {
  method: 'POST', headers, body: JSON.stringify({ text: 'still valid' }),
})
if (!initPrompt.ok) throw new Error('ACP 初始化会话返回后不可用')
await initPrompt.text()
initServer.closeAllConnections()
await new Promise<void>((resolve, reject) => initServer.close((error) => error ? reject(error) : resolve()))

const blockingProvider = new BlockingProvider()
const cancelServer = createAcpServer({
  provider: blockingProvider,
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  authToken: 'secret',
  maxSessions: 1,
})
await new Promise<void>((resolve, reject) => {
  cancelServer.once('error', reject)
  cancelServer.listen(0, '127.0.0.1', resolve)
})
const cancelAddress = cancelServer.address()
if (!cancelAddress || typeof cancelAddress === 'string') throw new Error('ACP cancel server 未监听')
const cancelBase = `http://127.0.0.1:${cancelAddress.port}`
const cancelSessionResponse = await fetch(`${cancelBase}/session/new`, { method: 'POST', headers })
const cancelSession = await cancelSessionResponse.json() as { sessionId?: string }
if (!cancelSession.sessionId) throw new Error('ACP cancel sessionId 缺失')
const promptResponse = await fetch(`${cancelBase}/session/${cancelSession.sessionId}/prompt`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'keep running' }),
})
const activeLimit = await fetch(`${cancelBase}/session/new`, { method: 'POST', headers })
if (activeLimit.status !== 429) throw new Error('ACP 回收了正在运行的会话')
const cancelResponse = await fetch(`${cancelBase}/session/${cancelSession.sessionId}/cancel`, { method: 'POST', headers })
if (!cancelResponse.ok) throw new Error('ACP cancel 请求失败')
await promptResponse.text()
if (!blockingProvider.aborted) throw new Error('ACP cancel 未传递到 Agent/provider signal')
blockingProvider.aborted = false
const activeCloseSessionResponse = await fetch(`${cancelBase}/session/new`, { method: 'POST', headers })
const activeCloseSession = await activeCloseSessionResponse.json() as { sessionId?: string }
if (!activeCloseSessionResponse.ok || !activeCloseSession.sessionId) throw new Error('ACP 取消后未回收空闲会话')
const activeClosePrompt = await fetch(`${cancelBase}/session/${activeCloseSession.sessionId}/prompt`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'close active session' }),
})
const activeCloseResponse = await fetch(`${cancelBase}/session/${activeCloseSession.sessionId}/close`, { method: 'POST', headers })
if (activeCloseResponse.status !== 202) throw new Error(`ACP 活跃会话关闭未异步返回: ${activeCloseResponse.status}`)
await activeClosePrompt.text()
if (!blockingProvider.aborted) throw new Error('ACP 关闭活跃会话未取消 Agent')
const closedActivePrompt = await fetch(`${cancelBase}/session/${activeCloseSession.sessionId}/prompt`, { method: 'POST', headers, body: JSON.stringify({ text: 'closed' }) })
if (closedActivePrompt.status !== 404) throw new Error('ACP 关闭后活跃会话仍可执行')
cancelServer.closeAllConnections()
await new Promise<void>((resolve, reject) => cancelServer.close((error) => error ? reject(error) : resolve()))

const closeProvider = new BlockingProvider()
const closeHooks = new HookEngine([
  { event: 'round_end', action: { type: 'inject_prompt', content: 'closing round injection' } },
])
const fired: string[] = []
const originalFire = closeHooks.fire.bind(closeHooks)
closeHooks.fire = async (event, context) => {
  await originalFire(event, context)
  fired.push(event)
}
const closeServer = createAcpServer({
  provider: closeProvider,
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  hooks: closeHooks,
  authToken: 'secret',
})
await new Promise<void>((resolve, reject) => {
  closeServer.once('error', reject)
  closeServer.listen(0, '127.0.0.1', resolve)
})
const closeAddress = closeServer.address()
if (!closeAddress || typeof closeAddress === 'string') throw new Error('ACP close server 未监听')
const closeBase = `http://127.0.0.1:${closeAddress.port}`
const closeSessionResponse = await fetch(`${closeBase}/session/new`, { method: 'POST', headers })
const closeSession = await closeSessionResponse.json() as { sessionId?: string }
if (!closeSession.sessionId) throw new Error('ACP close sessionId 缺失')
const closingPrompt = await fetch(`${closeBase}/session/${closeSession.sessionId}/prompt`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'close while running' }),
})
closeServer.closeAllConnections()
await new Promise<void>((resolve, reject) => closeServer.close((error) => error ? reject(error) : resolve()))
await closingPrompt.text().catch(() => '')
for (let attempt = 0; attempt < 50 && (!fired.includes('round_end') || !fired.includes('session_end')); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (!closeProvider.aborted || !fired.includes('round_end') || !fired.includes('session_end')) {
  throw new Error(`ACP 关闭时未等待 Agent 完成: ${JSON.stringify(fired)}`)
}
const pendingInjections = (closeHooks as unknown as { injections: Map<string, string[]> }).injections
if (pendingInjections.size !== 0) throw new Error('ACP 关闭后仍残留 round_end Hook 注入')

const bodyLimitServer = createAcpServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  authToken: 'secret',
  maxBodyBytes: 128,
})
await new Promise<void>((resolve, reject) => {
  bodyLimitServer.once('error', reject)
  bodyLimitServer.listen(0, '127.0.0.1', resolve)
})
const bodyLimitAddress = bodyLimitServer.address()
if (!bodyLimitAddress || typeof bodyLimitAddress === 'string') throw new Error('ACP body limit server 未监听')
const bodyLimitBase = `http://127.0.0.1:${bodyLimitAddress.port}`
const bodyLimitSessionResponse = await fetch(`${bodyLimitBase}/session/new`, { method: 'POST', headers })
const bodyLimitSession = await bodyLimitSessionResponse.json() as { sessionId?: string }
if (!bodyLimitSession.sessionId) throw new Error('ACP body limit sessionId 缺失')
const oversized = await fetch(`${bodyLimitBase}/session/${bodyLimitSession.sessionId}/prompt`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'x'.repeat(1024) }),
})
if (oversized.status !== 413) throw new Error(`ACP 超限请求未返回 413: ${oversized.status}`)
const healthyAfterOversize = await fetch(`${bodyLimitBase}/health`, { headers })
if (!healthyAfterOversize.ok) throw new Error('ACP 超限请求破坏了服务连接')
bodyLimitServer.closeAllConnections()
await new Promise<void>((resolve, reject) => bodyLimitServer.close((error) => error ? reject(error) : resolve()))
console.log('acp_test passed')
