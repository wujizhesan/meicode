import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import type { A2AStreamResponse } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { RuntimeEventLog } from '../src/runtime/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

class BlockingProvider implements Provider {
  readonly protocol = 'openai' as const
  started = false

  async *streamChat(_messages: ChatMessage[], opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    this.started = true
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) resolve()
      else opts.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    yield { type: 'done' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-shutdown-'))
const provider = new BlockingProvider()
const terminalRelease = gate()
const terminalEvents: A2AStreamResponse[] = []
let terminalDelivered = false
const webhook = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk.toString() })
  req.on('end', async () => {
    const event = JSON.parse(body) as A2AStreamResponse
    if (event.statusUpdate?.final) {
      terminalEvents.push(event)
      await terminalRelease.promise
    }
    res.writeHead(204)
    res.end()
    if (event.statusUpdate?.final) terminalDelivered = true
  })
})
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const runtimeEvents = new RuntimeEventLog(join(root, 'runtime'))
let closing: Promise<void> | undefined
let server: ReturnType<typeof createA2aServer> | undefined

try {
  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject)
    webhook.listen(0, '127.0.0.1', resolve)
  })
  const webhookAddress = webhook.address()
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('关闭测试回调未监听')
  const pushUrl = `http://127.0.0.1:${webhookAddress.port}/events`
  server = createA2aServer({
    provider,
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskRoot: join(root, 'tasks'),
    pushAllowedUrls: [pushUrl],
    runtimeEvents,
    sessionId: 'push-shutdown-test',
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A2A 关闭测试服务未监听')
  const response = await fetch(`http://127.0.0.1:${address.port}/message:send`, {
    method: 'POST',
    headers: { 'content-type': 'application/a2a+json' },
    body: JSON.stringify({
      message: { parts: [{ kind: 'text', text: 'shutdown' }] },
      configuration: { returnImmediately: true, taskPushNotificationConfig: { id: 'shutdown-hook', url: pushUrl } },
    }),
  })
  if (!response.ok) throw new Error(`A2A 关闭测试任务创建失败: ${response.status}`)
  const result = await response.json() as { task?: { id?: string } }
  if (!result.task?.id) throw new Error('A2A 关闭测试缺少任务 ID')
  await waitFor(() => provider.started, '模型未启动')

  closing = closeHttpServer(server)
  await waitFor(() => terminalEvents.length > 0, '服务关闭未生成终态 Push')
  if (terminalEvents[0].statusUpdate?.status.state !== 'TASK_STATE_CANCELED') throw new Error('服务关闭终态不是取消状态')
  const drained = await server.drainPushNotifications(40)
  if (drained) throw new Error('阻塞中的 Push 被误判为已排空')
  const auditKinds = runtimeEvents.read('push-shutdown-test').map((event) => event.payload?.kind)
  if (!auditKinds.includes('a2a_push_drain_timeout')) throw new Error('Push 排空超时缺少审计记录')
  let closed = false
  void closing.then(() => { closed = true })
  await new Promise((resolve) => setTimeout(resolve, 80))
  if (closed) throw new Error('HTTP 服务关闭未等待 Push 投递')
  terminalRelease.release()
  await closing
  if (!terminalDelivered) throw new Error('服务退出前终态 Push 未完成投递')
} finally {
  terminalRelease.release()
  if (closing) await closing
  else if (server) await closeHttpServer(server)
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_shutdown_test passed')
