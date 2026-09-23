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

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-shutdown-timeout-'))
const store = new A2aTaskStore(join(root, 'tasks'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
let releaseBlocked!: () => void
const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve })
let blockResponses = true
const received: Array<{ path: string; deliveryId?: string }> = []
const webhook = createServer((req, res) => {
  req.resume()
  req.on('end', async () => {
    const deliveryId = req.headers['x-a2a-delivery-id']
    received.push({ path: req.url ?? '', ...(typeof deliveryId === 'string' ? { deliveryId } : {}) })
    if (blockResponses) await blocked
    if (!res.destroyed) {
      res.writeHead(204)
      res.end()
    }
  })
})
let firstServer: ReturnType<typeof createA2aServer> | undefined
let restoredServer: ReturnType<typeof createA2aServer> | undefined

try {
  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject)
    webhook.listen(0, '127.0.0.1', resolve)
  })
  const webhookAddress = webhook.address()
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('关闭超时测试回调未监听')
  const pushBase = `http://127.0.0.1:${webhookAddress.port}`
  const status: A2ATask['status'] = { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() }
  const task: A2ATask = { id: 'timeout-task', contextId: 'timeout-task', status, history: [], artifacts: [] }
  const configs: A2APushNotificationConfig[] = ['first', 'second'].map((id) => ({ id, taskId: task.id, url: `${pushBase}/${id}` }))
  const outbox: A2APushOutboxEntry[] = configs.map((config) => ({
    deliveryId: `delivery-${config.id}`,
    config,
    event: { kind: 'terminal', status },
    attempts: 0,
    nextAttemptAt: Date.now(),
  }))
  store.save(task, configs, outbox)
  const createServerInstance = () => createA2aServer({
    provider: new IdleProvider(),
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: store,
    pushAllowedUrls: configs.map((config) => config.url),
    maxConcurrentPushDeliveries: 1,
  })
  const listen = async (server: ReturnType<typeof createA2aServer>): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  }

  firstServer = createServerInstance()
  await listen(firstServer)
  await waitFor(() => received.length === 1, '关闭超时前未开始首条 Push')
  if (received[0].path !== '/first') throw new Error('关闭超时测试初始投递顺序错误')
  await closeHttpServer(firstServer)
  if (!await firstServer.drainPushNotifications(1000)) throw new Error('关闭超时后仍有未收束的 Push 队列')
  if (received.length !== 1) throw new Error('关闭超时后启动了排队中的 Push')
  const pending = store.load().find((item) => item.task.id === task.id)?.pendingPushDeliveries ?? []
  if (pending.length !== 2 || pending.some((entry) => entry.attempts !== 0)) throw new Error('关闭超时后 Outbox 未保留原投递状态')
  firstServer = undefined

  blockResponses = false
  releaseBlocked()
  await new Promise((resolve) => setTimeout(resolve, 80))
  if (received.length !== 1) throw new Error('服务关闭后仍继续发送 Push')
  restoredServer = createServerInstance()
  await listen(restoredServer)
  await waitFor(() => received.length === 3, '重启后未补投积压 Push')
  if (received.map((item) => item.path).join(',') !== '/first,/first,/second') throw new Error(`重启补投顺序错误: ${received.map((item) => item.path).join(',')}`)
  if (received[0].deliveryId !== received[1].deliveryId || received[2].deliveryId !== 'delivery-second') throw new Error('重启后投递 ID 不稳定')
  await waitFor(() => (store.load().find((item) => item.task.id === task.id)?.pendingPushDeliveries.length ?? -1) === 0, '重启补投后 Outbox 未清空')
} finally {
  releaseBlocked()
  if (firstServer) await closeHttpServer(firstServer)
  if (restoredServer) await closeHttpServer(restoredServer)
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_shutdown_timeout_test passed')
