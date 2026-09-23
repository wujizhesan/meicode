import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2APushNotificationConfig, A2APushOutboxEntry, A2ATask } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { RuntimeEventLog } from '../src/runtime/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class IdleProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'done' }
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-retention-'))
const store = new A2aTaskStore(join(root, 'tasks'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const runtimeEvents = new RuntimeEventLog(join(root, 'runtime'))
let releaseResponses!: () => void
const responseGate = new Promise<void>((resolve) => { releaseResponses = resolve })
const received: string[] = []
const webhook = createServer((req, res) => {
  req.resume()
  req.on('end', async () => {
    received.push(req.url ?? '')
    await responseGate
    res.writeHead(req.url === '/failure' ? 400 : 204)
    res.end()
  })
})
let server: ReturnType<typeof createA2aServer> | undefined

try {
  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject)
    webhook.listen(0, '127.0.0.1', resolve)
  })
  const webhookAddress = webhook.address()
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('Outbox 保留测试回调未监听')
  const pushBase = `http://127.0.0.1:${webhookAddress.port}`
  const seed = (id: string, ageMs: number, targetStore = store): void => {
    const status: A2ATask['status'] = { state: 'TASK_STATE_COMPLETED', timestamp: new Date(Date.now() - ageMs).toISOString() }
    const task: A2ATask = { id, contextId: id, status, history: [], artifacts: [] }
    const config: A2APushNotificationConfig = { id: `${id}-hook`, taskId: id, url: `${pushBase}/${id}` }
    const outbox: A2APushOutboxEntry = { deliveryId: `${id}-delivery`, config, event: { kind: 'terminal', status }, attempts: 0, nextAttemptAt: Date.now() }
    targetStore.save(task, [config], [outbox])
  }
  seed('success', 200)
  seed('failure', 200)
  seed('expired', 120_000)

  server = createA2aServer({
    provider: new IdleProvider(),
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: store,
    taskTtlMs: 50,
    pushOutboxMaxAgeMs: 60_000,
    pushAllowedUrls: ['success', 'failure', 'expired'].map((id) => `${pushBase}/${id}`),
    runtimeEvents,
    sessionId: 'outbox-retention-test',
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Outbox 保留测试服务未监听')
  const base = `http://127.0.0.1:${address.port}`
  await waitFor(() => received.includes('/success') && received.includes('/failure'), '未恢复 TTL 已过但仍待投递的通知')
  if (received.includes('/expired')) throw new Error('超过 Outbox 最长保留期限的通知仍被投递')
  for (const id of ['success', 'failure']) {
    const response = await fetch(`${base}/tasks/${id}`)
    if (!response.ok) throw new Error(`待投递任务被提前清理: ${id}`)
  }
  const expiredResponse = await fetch(`${base}/tasks/expired`)
  if (expiredResponse.status !== 404) throw new Error('超过 Outbox 最长保留期限的任务未清理')
  if (!runtimeEvents.read('outbox-retention-test').some((event) => event.payload?.kind === 'a2a_push_outbox_expired')) throw new Error('Outbox 到期清理缺少审计记录')

  releaseResponses()
  if (!await server.drainPushNotifications(2_000)) throw new Error('Outbox 保留测试投递未排空')
  const listResponse = await fetch(`${base}/tasks`)
  const list = await listResponse.json() as { tasks?: unknown[] }
  if (!listResponse.ok || list.tasks?.length !== 0) throw new Error('投递结束后过期任务未清理')
  if (store.load().length !== 0) throw new Error('投递结束后磁盘任务记录未清理')
  if (received.filter((path) => path === '/failure').length !== 1) throw new Error('不可重试失败仍被重试')

  await closeHttpServer(server)
  server = undefined
  const metadataStore = new A2aTaskStore(join(root, 'metadata-tasks'))
  seed('metadata-only', 120_000, metadataStore)
  server = createA2aServer({
    provider: new IdleProvider(),
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: metadataStore,
    taskTtlMs: 240_000,
    pushOutboxMaxAgeMs: 60_000,
    pushAllowedUrls: [`${pushBase}/metadata-only`],
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const metadataAddress = server.address()
  if (!metadataAddress || typeof metadataAddress === 'string') throw new Error('Outbox 元数据保留测试服务未监听')
  const metadataResponse = await fetch(`http://127.0.0.1:${metadataAddress.port}/tasks/metadata-only`)
  if (!metadataResponse.ok) throw new Error('Outbox 到期时误删未到任务 TTL 的任务')
  if (metadataStore.load().find((item) => item.task.id === 'metadata-only')?.pendingPushDeliveries.length !== 0) throw new Error('任务 TTL 未到时 Outbox 最长保留期限未生效')
  if (received.includes('/metadata-only')) throw new Error('超过 Outbox 最长保留期限的通知仍被投递')
} finally {
  releaseResponses()
  if (server) await closeHttpServer(server)
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_outbox_retention_test passed')
