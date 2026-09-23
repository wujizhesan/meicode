import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class HoldingProvider implements Provider {
  readonly protocol = 'openai' as const
  private releaseGate!: () => void
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve })

  release(): void {
    this.releaseGate()
  }

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    await this.gate
    yield { type: 'text', text: 'completed' }
    yield { type: 'done' }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-sse-quota-'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const provider = new HoldingProvider()
const server = createA2aServer({
  provider,
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskRoot: join(root, 'tasks'),
  maxSseConnections: 2,
  maxSseConnectionsPerTask: 1,
})
const firstAbort = new AbortController()
const secondAbort = new AbortController()
let reopenedAbort: AbortController | undefined

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A2A SSE 配额测试服务未监听')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'content-type': 'application/a2a+json' }

  const createTask = async (text: string): Promise<string> => {
    const response = await fetch(`${base}/message:send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: { parts: [{ kind: 'text', text }] }, configuration: { returnImmediately: true } }),
    })
    const body = await response.json() as { task?: { id?: string } }
    assert(response.ok && body.task?.id, '测试任务创建失败')
    return body.task.id
  }

  const subscribe = (taskId: string, signal?: AbortSignal): Promise<Response> => fetch(`${base}/tasks/${encodeURIComponent(taskId)}:subscribe`, {
    method: 'POST',
    headers,
    signal,
  })

  const firstTaskId = await createTask('first pending task')
  const secondTaskId = await createTask('second pending task')
  const firstStream = await subscribe(firstTaskId, firstAbort.signal)
  if (firstStream.status !== 200) throw new Error(`首个 SSE 订阅失败: ${firstStream.status} ${await firstStream.text()}`)

  const perTaskRejected = await subscribe(firstTaskId)
  assert(perTaskRejected.status === 429, '单任务 SSE 连接上限未生效')
  await perTaskRejected.arrayBuffer()

  const secondStream = await subscribe(secondTaskId, secondAbort.signal)
  assert(secondStream.status === 200, '第二个任务 SSE 订阅失败')

  const before = await fetch(`${base}/tasks`).then((response) => response.json()) as { totalSize?: number }
  const globalRejected = await fetch(`${base}/message:stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'must not be created' }] } }),
  })
  assert(globalRejected.status === 429, '服务级 SSE 连接上限未生效')
  await globalRejected.arrayBuffer()
  const rpcRejected = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'SendStreamingMessage', params: { message: { parts: [{ kind: 'text', text: 'rpc must not be created' }] } } }),
  })
  assert(rpcRejected.status === 429, 'JSON-RPC 流式请求未遵守服务级 SSE 上限')
  await rpcRejected.arrayBuffer()
  const after = await fetch(`${base}/tasks`).then((response) => response.json()) as { totalSize?: number }
  assert(before.totalSize === 2 && after.totalSize === 2, '超额流式请求仍创建了任务')

  firstAbort.abort()
  let reopened: Response | undefined
  for (let attempt = 0; attempt < 50; attempt++) {
    reopenedAbort = new AbortController()
    const response = await subscribe(firstTaskId, reopenedAbort.signal)
    if (response.status === 200) {
      reopened = response
      break
    }
    assert(response.status === 429, `释放后重试返回异常状态: ${response.status}`)
    await response.arrayBuffer()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert(reopened, '断连后 SSE 名额未释放')

  provider.release()
  const [secondText, reopenedText] = await Promise.all([secondStream.text(), reopened.text()])
  assert(secondText.includes('"final":true') && reopenedText.includes('"final":true'), '终态事件未送达现有 SSE 连接')

  const afterTerminal = await fetch(`${base}/message:stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'after terminal' }] } }),
  })
  assert(afterTerminal.status === 200, '终态后服务级 SSE 名额未释放')
  assert((await afterTerminal.text()).includes('"final":true'), '新流式请求缺少终态事件')

  const cancelTaskId = await createTask('cancel route')
  const canceled = await fetch(`${base}/tasks/${encodeURIComponent(cancelTaskId)}:cancel`, { method: 'POST', headers })
  const canceledBody = await canceled.json() as { task?: { id?: string } }
  assert(canceled.status === 200 && canceledBody.task?.id === cancelTaskId, 'REST :cancel 路由未正确解析任务 ID')

  const disabledServer = createA2aServer({
    provider,
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    maxSseConnectionsPerTask: 0,
  })
  try {
    await new Promise<void>((resolve, reject) => {
      disabledServer.once('error', reject)
      disabledServer.listen(0, '127.0.0.1', resolve)
    })
    const disabledAddress = disabledServer.address()
    if (!disabledAddress || typeof disabledAddress === 'string') throw new Error('A2A 禁用 SSE 测试服务未监听')
    const disabledBase = `http://127.0.0.1:${disabledAddress.port}`
    const disabledResponse = await fetch(`${disabledBase}/message:stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'disabled stream' }] } }),
    })
    assert(disabledResponse.status === 429, '单任务 SSE 上限为零时未拒绝流式请求')
    const disabledCard = await fetch(`${disabledBase}/.well-known/agent-card.json`).then((response) => response.json()) as { capabilities?: { streaming?: boolean } }
    assert(disabledCard.capabilities?.streaming === false, '禁用 SSE 后 Agent Card 仍宣称支持流式调用')
    const disabledTasks = await fetch(`${disabledBase}/tasks`).then((response) => response.json()) as { totalSize?: number }
    assert(disabledTasks.totalSize === 0, '拒绝流式请求后仍创建了任务')
  } finally {
    disabledServer.closeAllConnections()
    await new Promise<void>((resolve) => disabledServer.close(() => resolve()))
  }
} finally {
  provider.release()
  firstAbort.abort()
  secondAbort.abort()
  reopenedAbort?.abort()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_sse_quota_test passed')
