import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2ATask } from '../src/a2a/types.ts'
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

let releaseBlocking!: () => void
let signalBlockingStarted!: () => void
const blockingStarted = new Promise<void>((resolve) => { signalBlockingStarted = resolve })
const blockingGate = new Promise<void>((resolve) => { releaseBlocking = resolve })
class BlockingProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    signalBlockingStarted()
    await blockingGate
    yield { type: 'text', text: 'blocking result' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_a2a_limits')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
for (const taskTtlMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  try {
    createA2aServer({ provider: new FakeProvider(), registry: new ToolRegistry(), engine, cwd: process.cwd(), taskTtlMs })
  } catch (error) {
    if ((error as Error).message === 'A2A taskTtlMs 无效') continue
    throw error
  }
  throw new Error(`A2A 无效 taskTtlMs 未被拒绝: ${taskTtlMs}`)
}
for (const maxConcurrentTasks of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  try {
    createA2aServer({ provider: new FakeProvider(), registry: new ToolRegistry(), engine, cwd: process.cwd(), maxConcurrentTasks })
  } catch (error) {
    if ((error as Error).message === 'A2A maxConcurrentTasks 无效') continue
    throw error
  }
  throw new Error(`A2A 无效 maxConcurrentTasks 未被拒绝: ${maxConcurrentTasks}`)
}
const runtimeEvents = new RuntimeEventLog(join(root, 'runtime'))
const server = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskRoot: join(root, 'tasks'),
  maxActiveTasks: 1,
  maxConcurrentTasks: 1,
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
const firstTask = await first.json() as { task?: { id?: string } }
if (!firstTask.task?.id) throw new Error('A2A 首个任务 ID 缺失')
const second = await fetch(`${base}/message:send`, { method: 'POST', headers, body: body('second') })
if (!second.ok) throw new Error(`A2A 已完成任务仍占新建额度: ${second.status}`)
const retainedHistory = await fetch(`${base}/tasks/${firstTask.task.id}`)
if (!retainedHistory.ok) throw new Error('A2A 释放新建额度时误删了已完成任务')
const auditKinds = runtimeEvents.read('audit-test-session').filter((event) => event.type === 'audit').map((event) => String(event.payload?.kind))
for (const kind of ['a2a_task_created', 'a2a_task_started', 'a2a_task_finished']) {
  if (!auditKinds.includes(kind)) throw new Error(`A2A 审计事件缺失: ${kind}`)
}

server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

const blockingEvents = new RuntimeEventLog(join(root, 'blocking-runtime'))
const blockingServer = createA2aServer({
  provider: new BlockingProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskRoot: join(root, 'blocking-tasks'),
  maxActiveTasks: 1,
  runtimeEvents: blockingEvents,
  sessionId: 'blocking-test-session',
})
await new Promise<void>((resolve, reject) => {
  blockingServer.once('error', reject)
  blockingServer.listen(0, '127.0.0.1', resolve)
})
const blockingAddress = blockingServer.address()
if (!blockingAddress || typeof blockingAddress === 'string') throw new Error('A2A blocking server 未监听')
const blockingBase = `http://127.0.0.1:${blockingAddress.port}`
const pendingResponse = await fetch(`${blockingBase}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'pending' }] }, configuration: { returnImmediately: true } }),
})
const pending = await pendingResponse.json() as { task?: { id?: string } }
if (!pendingResponse.ok || !pending.task?.id) throw new Error('A2A 活跃任务未创建')
await blockingStarted
const saturated = await fetch(`${blockingBase}/message:send`, { method: 'POST', headers, body: body('while pending') })
if (saturated.status !== 429) throw new Error(`A2A 活跃任务上限未生效: ${saturated.status}`)
releaseBlocking()
for (let attempt = 0; attempt < 50; attempt++) {
  const statusResponse = await fetch(`${blockingBase}/tasks/${pending.task.id}`)
  const status = await statusResponse.json() as { task?: { status?: { state?: string } } }
  if (status.task?.status?.state === 'TASK_STATE_COMPLETED') break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const afterCompletion = await fetch(`${blockingBase}/message:send`, { method: 'POST', headers, body: body('after completion') })
if (!afterCompletion.ok) throw new Error(`A2A 终态任务未释放新建额度: ${afterCompletion.status}`)
const blockingAuditKinds = blockingEvents.read('blocking-test-session').filter((event) => event.type === 'audit').map((event) => String(event.payload?.kind))
if (!blockingAuditKinds.includes('a2a_quota_rejected')) throw new Error('A2A 活跃任务额度拒绝未记录审计')
blockingServer.closeAllConnections()
await new Promise<void>((resolve, reject) => blockingServer.close((error) => error ? reject(error) : resolve()))

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

const targetedStore = new A2aTaskStore(join(root, 'targeted-tasks'))
const timestamp = new Date(Date.now() + 500).toISOString()
const expiredTask = (id: string, messageId: string): A2ATask => ({
  id,
  contextId: 'targeted-context',
  status: { state: 'TASK_STATE_COMPLETED', timestamp },
  history: [{ messageId, role: 'ROLE_USER', parts: [{ kind: 'text', text: id }] }],
  artifacts: [],
})
targetedStore.save(expiredTask('targeted-one', 'targeted-message-one'))
targetedStore.save(expiredTask('targeted-two', 'targeted-message-two'))
const targetedServer = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskStore: targetedStore,
  taskTtlMs: 100,
})
if (targetedStore.load().length !== 2) throw new Error('A2A 按需清理测试任务在启动时提前过期')
await new Promise<void>((resolve, reject) => {
  targetedServer.once('error', reject)
  targetedServer.listen(0, '127.0.0.1', resolve)
})
const targetedAddress = targetedServer.address()
if (!targetedAddress || typeof targetedAddress === 'string') throw new Error('A2A targeted server 未监听')
const targetedBase = `http://127.0.0.1:${targetedAddress.port}`
await new Promise((resolve) => setTimeout(resolve, 750))
const expiredResponse = await fetch(`${targetedBase}/tasks/targeted-one`)
if (expiredResponse.status !== 404) throw new Error('A2A 按 ID 查询未清理过期目标任务')
const remainingTaskIds = targetedStore.load().map((item) => item.task.id)
if (remainingTaskIds.length !== 1 || remainingTaskIds[0] !== 'targeted-two') throw new Error('A2A 按 ID 查询误扫了无关过期任务')
const retriedResponse = await fetch(`${targetedBase}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { messageId: 'targeted-message-two', parts: [{ kind: 'text', text: 'retry expired' }] } }),
})
const retried = await retriedResponse.json() as { task?: { id?: string } }
if (!retriedResponse.ok || !retried.task?.id || retried.task.id === 'targeted-two') throw new Error('A2A 过期任务的 messageId 未允许重新创建任务')
if (targetedStore.load().some((item) => item.task.id === 'targeted-two')) throw new Error('A2A messageId 查询未清理过期目标任务')
targetedServer.closeAllConnections()
await new Promise<void>((resolve, reject) => targetedServer.close((error) => error ? reject(error) : resolve()))

const noExpiryStore = new A2aTaskStore(join(root, 'no-expiry-tasks'))
const noExpiryTask = expiredTask('no-expiry', 'no-expiry-message')
noExpiryTask.status.timestamp = new Date(0).toISOString()
noExpiryStore.save(noExpiryTask)
const noExpiryServer = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskStore: noExpiryStore,
  taskTtlMs: 0,
})
await new Promise<void>((resolve, reject) => {
  noExpiryServer.once('error', reject)
  noExpiryServer.listen(0, '127.0.0.1', resolve)
})
const noExpiryAddress = noExpiryServer.address()
if (!noExpiryAddress || typeof noExpiryAddress === 'string') throw new Error('A2A no-expiry server 未监听')
const noExpiryResponse = await fetch(`http://127.0.0.1:${noExpiryAddress.port}/tasks/no-expiry`)
if (!noExpiryResponse.ok || noExpiryStore.load().length !== 1) throw new Error('A2A taskTtlMs=0 未保留终态任务')
noExpiryServer.closeAllConnections()
await new Promise<void>((resolve, reject) => noExpiryServer.close((error) => error ? reject(error) : resolve()))

rmSync(root, { recursive: true, force: true })
console.log('a2a_limits_test passed')
