import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { RuntimeEventLog } from '../src/runtime/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: 'limited result' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_a2a_limits')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const runtimeEvents = new RuntimeEventLog(join(root, 'runtime'))
const server = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskRoot: join(root, 'tasks'),
  maxTasks: 1,
  taskTtlMs: 5_000,
  runtimeEvents,
  sessionId: 'audit-test-session',
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('A2A limits server 未监听')
const base = `http://127.0.0.1:${address.port}`
const headers = { 'content-type': 'application/a2a+json', 'A2A-Version': '1.0' }
const body = (text: string) => JSON.stringify({ message: { parts: [{ kind: 'text', text }] } })

const first = await fetch(`${base}/message:send`, { method: 'POST', headers, body: body('first') })
if (!first.ok) throw new Error(`A2A 首个任务失败: ${first.status}`)
if (!first.headers.get('x-request-id')) throw new Error('A2A request id 响应头缺失')
const second = await fetch(`${base}/message:send`, { method: 'POST', headers, body: body('second') })
if (second.status !== 429) throw new Error(`A2A 任务上限未生效: ${second.status}`)
const auditKinds = runtimeEvents.read('audit-test-session').filter((event) => event.type === 'audit').map((event) => String(event.payload?.kind))
for (const kind of ['a2a_task_created', 'a2a_task_started', 'a2a_task_finished', 'a2a_quota_rejected']) {
  if (!auditKinds.includes(kind)) throw new Error(`A2A 审计事件缺失: ${kind}`)
}

server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

const ttlServer = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskRoot: join(root, 'ttl-tasks'),
  maxTasks: 1,
  taskTtlMs: 20,
})
await new Promise<void>((resolve, reject) => {
  ttlServer.once('error', reject)
  ttlServer.listen(0, '127.0.0.1', resolve)
})
const ttlAddress = ttlServer.address()
if (!ttlAddress || typeof ttlAddress === 'string') throw new Error('A2A TTL server 未监听')
const ttlBase = `http://127.0.0.1:${ttlAddress.port}`
const ttlFirst = await fetch(`${ttlBase}/message:send`, { method: 'POST', headers, body: body('ttl first') })
if (!ttlFirst.ok) throw new Error(`A2A TTL 首个任务失败: ${ttlFirst.status}`)
await new Promise((resolve) => setTimeout(resolve, 40))
const listed = await fetch(`${ttlBase}/tasks`)
const list = await listed.json() as { tasks?: unknown[] }
if (!listed.ok || list.tasks?.length !== 0) throw new Error('A2A 终态任务 TTL 未清理')
const afterTtl = await fetch(`${ttlBase}/message:send`, { method: 'POST', headers, body: body('after ttl') })
if (!afterTtl.ok) throw new Error(`A2A TTL 后未释放任务额度: ${afterTtl.status}`)
ttlServer.closeAllConnections()
await new Promise<void>((resolve, reject) => ttlServer.close((error) => error ? reject(error) : resolve()))
rmSync(root, { recursive: true, force: true })
console.log('a2a_limits_test passed')
