import { createAcpServer } from '../src/acp.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { join } from 'node:path'
import { RuntimeEventLog } from '../src/runtime/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_acp')
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const runtimeEvents = new RuntimeEventLog(join(root, 'runtime'))
const server = createAcpServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  authToken: 'secret',
  maxSessions: 1,
  sessionTtlMs: 60_000,
  runtimeEvents,
  sessionId: 'acp-audit-test',
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

const limited = await fetch(`${base}/session/new`, { method: 'POST', headers })
if (limited.status !== 429) throw new Error('ACP 会话上限未生效')

server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
console.log('acp_test passed')
