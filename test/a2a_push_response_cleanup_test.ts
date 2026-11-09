import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
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

class GatedProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly success = gate()
  readonly failure = gate()

  async *streamChat(messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    if (messages.some((message) => message.content === 'push-success')) await this.success.promise
    else await this.failure.promise
    yield { type: 'done' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-response-'))
const provider = new GatedProvider()
let successRequests = 0
let successClosed = 0
let failureRequests = 0
let failureClosed = 0
const webhook = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.url === '/success') {
      successRequests++
      res.on('close', () => { successClosed++ })
      res.writeHead(200, { 'content-type': 'text/plain' })
    } else {
      failureRequests++
      res.on('close', () => { failureClosed++ })
      res.writeHead(503, { 'content-type': 'text/plain' })
    }
    res.write('body that never ends')
  })
})
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
let server: ReturnType<typeof createA2aServer> | undefined

try {
  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject)
    webhook.listen(0, '127.0.0.1', resolve)
  })
  const webhookAddress = webhook.address()
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('Push 响应体测试回调未监听')
  const hookBase = `http://127.0.0.1:${webhookAddress.port}`
  server = createA2aServer({
    provider,
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskRoot: join(root, 'tasks'),
    pushAllowedUrls: [`${hookBase}/success`, `${hookBase}/failure`],
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A2A Push 响应体测试服务未监听')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'content-type': 'application/a2a+json' }
  const createTask = async (content: string): Promise<string> => {
    const response = await fetch(`${base}/message:send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: { parts: [{ kind: 'text', text: content }] }, configuration: { returnImmediately: true } }),
    })
    const body = await response.json() as { task?: { id?: string } }
    if (!response.ok || !body.task?.id) throw new Error(`Push 响应体测试任务创建失败: ${content}`)
    return body.task.id
  }
  const addConfig = async (taskId: string, id: string): Promise<void> => {
    const response = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, url: `${hookBase}/${id}` }),
    })
    if (!response.ok) throw new Error(`Push 响应体测试配置创建失败: ${id}`)
  }

  const successTask = await createTask('push-success')
  await addConfig(successTask, 'success')
  provider.success.release()
  if (!(await server.drainPushNotifications(2000))) throw new Error('成功回调响应体未在期限内释放')
  await waitFor(() => successClosed === 1, '成功回调的流式响应连接未关闭')
  if (successRequests !== 1) throw new Error(`成功回调被重复投递: ${successRequests}`)

  const failureTask = await createTask('push-failure')
  await addConfig(failureTask, 'failure')
  provider.failure.release()
  if (!(await server.drainPushNotifications(2000))) throw new Error('失败回调响应体未在期限内释放')
  await waitFor(() => failureClosed === 2, '失败回调重试后的流式响应连接未全部关闭')
  if (failureRequests !== 2) throw new Error(`失败回调重试次数错误: ${failureRequests}`)
} finally {
  provider.success.release()
  provider.failure.release()
  const activeServer = server
  if (activeServer) {
    activeServer.closeAllConnections()
    await new Promise<void>((resolve) => activeServer.close(() => resolve()))
  }
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_response_cleanup_test passed')
