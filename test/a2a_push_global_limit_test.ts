import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2APushNotificationConfig, A2APushOutboxEntry, A2ATask } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class IdleProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'done' }
  }
}

class OrderedTaskStore extends A2aTaskStore {
  override loadMetadata() {
    return super.loadMetadata().sort((left, right) => left.id.localeCompare(right.id))
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-global-'))
const store = new OrderedTaskStore(join(root, 'tasks'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
let releaseRequests!: () => void
const requestGate = new Promise<void>((resolve) => { releaseRequests = resolve })
const received: string[] = []
let active = 0
let peak = 0
const webhook = createServer((req, res) => {
  req.resume()
  req.on('end', async () => {
    received.push(req.url ?? '')
    active++
    peak = Math.max(peak, active)
    await requestGate
    active--
    res.writeHead(204)
    res.end()
  })
})
let server: ReturnType<typeof createA2aServer> | undefined
let closing: Promise<void> | undefined

try {
  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject)
    webhook.listen(0, '127.0.0.1', resolve)
  })
  const webhookAddress = webhook.address()
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('全局限流测试回调未监听')
  const pushBase = `http://127.0.0.1:${webhookAddress.port}`
  const allowedUrls: string[] = []
  const seedTask = (taskId: string, configIds: string[]): void => {
    const status: A2ATask['status'] = { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() }
    const task: A2ATask = { id: taskId, contextId: taskId, status, history: [], artifacts: [] }
    const configs: A2APushNotificationConfig[] = configIds.map((id) => {
      const url = `${pushBase}/${id}`
      allowedUrls.push(url)
      return { id, taskId, url }
    })
    const outbox: A2APushOutboxEntry[] = configs.map((config) => ({
      deliveryId: `delivery-${config.id}`,
      config,
      event: { kind: 'terminal', status },
      attempts: 0,
      nextAttemptAt: Date.now(),
    }))
    store.save(task, configs, outbox)
  }
  seedTask('a-task', ['a-0', 'a-1', 'a-2'])
  seedTask('b-task', ['b-0'])
  seedTask('c-task', ['c-0'])

  server = createA2aServer({
    provider: new IdleProvider(),
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: store,
    pushAllowedUrls: allowedUrls,
    maxConcurrentPushDeliveries: 1,
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('全局限流测试服务未监听')
  await waitFor(() => received.length === 1, '恢复后未开始首条 Push')
  await new Promise((resolve) => setTimeout(resolve, 80))
  if (received.length !== 1 || peak !== 1) throw new Error(`Push 服务级并发上限失效: received=${received.length}, peak=${peak}`)

  const deleted = await fetch(`http://127.0.0.1:${address.port}/tasks/c-task/pushNotificationConfigs/c-0`, { method: 'DELETE' })
  if (!deleted.ok) throw new Error('排队期间删除 Push 配置失败')
  if (store.load().find((item) => item.task.id === 'c-task')?.pendingPushDeliveries.length !== 0) throw new Error('删除配置后待投递项未清空')

  closing = closeHttpServer(server)
  releaseRequests()
  await waitFor(() => received.length === 4 && active === 0, '积压的 Push 未完成投递')
  await closing
  if (peak !== 1) throw new Error(`Push 服务级并发峰值错误: ${peak}`)
  if (received.includes('/c-0')) throw new Error('已删除的 Push 配置仍被投递')
  if (received.indexOf('/b-0') < 0 || received.indexOf('/b-0') > received.indexOf('/a-2')) throw new Error(`跨任务调度不公平: ${received.join(',')}`)
  if (store.load().some((item) => item.pendingPushDeliveries.length > 0)) throw new Error('成功投递后 Outbox 未清空')
} finally {
  releaseRequests()
  if (closing) await closing
  else if (server) await closeHttpServer(server)
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_global_limit_test passed')
