import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2AStreamResponse } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: 'durable result' }
    yield { type: 'done' }
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 400; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-outbox-'))
const store = new A2aTaskStore(join(root, 'tasks'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
let failArtifacts = true
const received: Array<{ taskId: string; kind: string; deliveryId?: string }> = []
const webhook = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk.toString() })
  req.on('end', () => {
    const event = JSON.parse(body) as A2AStreamResponse
    const kind = event.artifactUpdate ? 'artifact' : event.statusUpdate?.final ? 'terminal' : 'other'
    const taskId = event.artifactUpdate?.taskId ?? event.statusUpdate?.taskId ?? event.task?.id ?? ''
    const deliveryId = req.headers['x-a2a-delivery-id']
    received.push({ taskId, kind, ...(typeof deliveryId === 'string' ? { deliveryId } : {}) })
    res.writeHead(kind === 'artifact' && failArtifacts ? 503 : 204)
    res.end()
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
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('Outbox 测试回调未监听')
  const pushUrl = `http://127.0.0.1:${webhookAddress.port}/events`
  const createServerInstance = () => createA2aServer({
    provider: new FakeProvider(),
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: store,
    pushAllowedUrls: [pushUrl],
  })
  const listen = async (server: ReturnType<typeof createA2aServer>): Promise<string> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Outbox 测试服务未监听')
    return `http://127.0.0.1:${address.port}`
  }
  const send = async (base: string, messageId: string, configId: string): Promise<string> => {
    const response = await fetch(`${base}/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/a2a+json' },
      body: JSON.stringify({
        message: { messageId, parts: [{ kind: 'text', text: messageId }] },
        configuration: { taskPushNotificationConfig: { id: configId, url: pushUrl } },
      }),
    })
    const body = await response.json() as { task?: { id?: string } }
    if (!response.ok || !body.task?.id) throw new Error(`Outbox 测试任务创建失败: ${messageId}`)
    return body.task.id
  }

  firstServer = createServerInstance()
  const firstBase = await listen(firstServer)
  const taskId = await send(firstBase, 'outbox-restart', 'restart-hook')
  await waitFor(() => store.load().find((item) => item.task.id === taskId)?.pendingPushDeliveries.some((entry) => entry.event.kind === 'artifact' && entry.attempts === 1) ?? false, '首次失败未持久化退避记录')
  const pending = store.load().find((item) => item.task.id === taskId)?.pendingPushDeliveries ?? []
  if (pending.length !== 2 || pending[0].event.kind !== 'artifact' || pending[1].event.kind !== 'terminal') throw new Error('产物和终态 Outbox 顺序错误')
  if (received.some((item) => item.taskId === taskId && item.kind === 'terminal')) throw new Error('终态越过失败的产物通知')
  const artifactId = pending[0].deliveryId
  const terminalId = pending[1].deliveryId
  await closeHttpServer(firstServer)
  firstServer = undefined

  failArtifacts = false
  restoredServer = createServerInstance()
  const restoredBase = await listen(restoredServer)
  await waitFor(() => received.some((item) => item.taskId === taskId && item.kind === 'terminal'), '重启后未补送终态')
  const restoredEvents = received.filter((item) => item.taskId === taskId && item.kind !== 'other')
  if (restoredEvents.map((item) => item.kind).join(',') !== 'artifact,artifact,terminal') throw new Error(`重启补送事件顺序错误: ${restoredEvents.map((item) => item.kind).join(',')}`)
  if (restoredEvents[0].deliveryId !== artifactId || restoredEvents[1].deliveryId !== artifactId || restoredEvents[2].deliveryId !== terminalId) throw new Error('重试前后投递 ID 不稳定')
  await waitFor(() => (store.load().find((item) => item.task.id === taskId)?.pendingPushDeliveries.length ?? -1) === 0, '成功后 Outbox 未清空')

  failArtifacts = true
  const revokedTaskId = await send(restoredBase, 'outbox-revoked', 'revoked-hook')
  await waitFor(() => store.load().find((item) => item.task.id === revokedTaskId)?.pendingPushDeliveries.some((entry) => entry.event.kind === 'artifact' && entry.attempts === 1) ?? false, '撤销测试未形成待重试记录')
  const deleted = await fetch(`${restoredBase}/tasks/${encodeURIComponent(revokedTaskId)}/pushNotificationConfigs/revoked-hook`, { method: 'DELETE' })
  if (!deleted.ok) throw new Error('删除 Push 配置失败')
  const remaining = store.load().find((item) => item.task.id === revokedTaskId)?.pendingPushDeliveries.length
  if (remaining !== 0) throw new Error('删除 Push 配置后 Outbox 未清空')
  const countBefore = received.filter((item) => item.taskId === revokedTaskId && item.kind === 'artifact').length
  failArtifacts = false
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const countAfter = received.filter((item) => item.taskId === revokedTaskId && item.kind === 'artifact').length
  if (countAfter !== countBefore) throw new Error('删除 Push 配置后仍继续投递')
} finally {
  if (firstServer) await closeHttpServer(firstServer)
  if (restoredServer) await closeHttpServer(restoredServer)
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_outbox_test passed')
