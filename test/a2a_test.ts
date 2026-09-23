import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import { MEICODE_VERSION } from '../src/version.ts'
import { A2aClient } from '../src/a2a/client.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { HookEngine } from '../src/hook/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly captured: ChatMessage[][] = []

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    this.captured.push([..._messages])
    if (_messages.some((message) => message.content === 'immediate')) await new Promise((resolve) => setTimeout(resolve, 50))
    if (_messages.some((message) => message.content === 'push burst')) {
      for (let i = 0; i < 200; i++) yield { type: 'text', text: String(i % 10) }
      yield { type: 'done' }
      return
    }
    yield { type: 'text', text: 'A2A response' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_a2a')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const provider = new FakeProvider()
const hooks = new HookEngine([
  {
    event: 'round_start',
    if: { all: [{ match: 'sessionId', pattern: 'a2a:isolated-context' }] },
    action: { type: 'inject_prompt', content: 'A2A 隔离会话提示' },
  },
])
const notifications: { body: string; token?: string }[] = []
const redirectBodies: string[] = []
const webhook = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk.toString()))
  req.on('end', () => {
    if (req.url === '/redirect') {
      redirectBodies.push(body)
      res.writeHead(307, { location: '/events' })
    } else {
      notifications.push({ body, token: typeof req.headers['x-a2a-notification-token'] === 'string' ? req.headers['x-a2a-notification-token'] : undefined })
      res.writeHead(204)
    }
    res.end()
  })
})
await new Promise<void>((resolve, reject) => {
  webhook.once('error', reject)
  webhook.listen(0, '127.0.0.1', () => resolve())
})
const webhookAddress = webhook.address()
if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('Webhook 未监听')
const pushUrl = `http://127.0.0.1:${webhookAddress.port}/events`
const redirectUrl = `http://127.0.0.1:${webhookAddress.port}/redirect`
const server = createA2aServer({
  provider,
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  baseUrl: 'http://127.0.0.1',
  taskRoot: join(root, 'tasks'),
  hooks,
  pushAllowedUrls: [pushUrl, redirectUrl],
})

await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve())
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('A2A server 未监听')
const base = `http://127.0.0.1:${address.port}`
const headers = { 'content-type': 'application/a2a+json', 'A2A-Version': '1.0' }

const cardResponse = await fetch(`${base}/.well-known/agent-card.json`)
if (!cardResponse.ok) throw new Error('Agent Card 获取失败')
const card = await cardResponse.json() as { version?: string; capabilities?: { streaming?: boolean; pushNotifications?: boolean }; supportedInterfaces?: unknown[] }
if (!card.capabilities?.streaming || !card.capabilities.pushNotifications || card.supportedInterfaces?.length !== 2) throw new Error('Agent Card 能力声明不完整')
if (card.version !== MEICODE_VERSION) throw new Error(`Agent Card 版本不一致: ${card.version}`)

const sendResponse = await fetch(`${base}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { messageId: 'a2a-dedupe-1', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hello' }] } }),
})
if (!sendResponse.ok) throw new Error(`A2A send 失败: ${await sendResponse.text()}`)
const sent = await sendResponse.json() as { task?: { id: string; status: { state: string }; artifacts: { parts: { text: string }[] }[] } }
if (!sent.task || sent.task.status.state !== 'TASK_STATE_COMPLETED' || sent.task.artifacts[0]?.parts[0]?.text !== 'A2A response') {
  throw new Error(`A2A send 结果不正确: ${JSON.stringify(sent)}`)
}

const duplicateResponse = await fetch(`${base}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { messageId: 'a2a-dedupe-1', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hello' }] } }),
})
const duplicate = await duplicateResponse.json() as { task?: { id: string } }
if (!duplicate.task || duplicate.task.id !== sent.task.id) throw new Error('A2A messageId 重试未复用原任务')

const isolatedResponse = await fetch(`${base}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { contextId: 'isolated-context', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'isolated' }] } }),
})
if (!isolatedResponse.ok) throw new Error(`A2A 隔离上下文请求失败: ${await isolatedResponse.text()}`)
if (!provider.captured.some((messages) => messages.some((message) => message.content === 'A2A 隔离会话提示'))) {
  throw new Error('A2A 外部 contextId 未映射到隔离的内部会话命名空间')
}

const longContextResponse = await fetch(`${base}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { contextId: 'x'.repeat(129), role: 'ROLE_USER', parts: [{ kind: 'text', text: 'long context' }] } }),
})
if (longContextResponse.status !== 400) throw new Error(`A2A 超长 contextId 未拒绝: ${longContextResponse.status}`)

const taskResponse = await fetch(`${base}/tasks/${encodeURIComponent(sent.task.id)}`)
const task = await taskResponse.json() as { task?: { id: string } }
if (!task.task || task.task.id !== sent.task.id) throw new Error('A2A task 查询失败')

const clippedResponse = await fetch(`${base}/tasks/${encodeURIComponent(sent.task.id)}?historyLength=0`)
const clipped = await clippedResponse.json() as { task?: { history?: unknown[] } }
if (!clipped.task || clipped.task.history?.length !== 0) throw new Error('A2A historyLength 裁剪失败')

const immediateResponse = await fetch(`${base}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'immediate' }] }, configuration: { returnImmediately: true } }),
})
const immediate = await immediateResponse.json() as { task?: { id: string; status?: { state?: string } } }
if (!immediate.task || immediate.task.status?.state === 'TASK_STATE_COMPLETED') throw new Error('A2A returnImmediately 未立即返回')

const listResponse = await fetch(`${base}/tasks`)
const listed = await listResponse.json() as { tasks?: { id: string }[] }
if (!listed.tasks?.some((item) => item.id === sent.task!.id)) throw new Error('A2A task 列表缺少任务')
const pageResponse = await fetch(`${base}/tasks?pageSize=1`)
const page = await pageResponse.json() as { tasks?: unknown[]; totalSize?: number; nextPageToken?: string }
if (page.tasks?.length !== 1 || (page.totalSize ?? 0) < 2 || !page.nextPageToken) throw new Error('A2A task 分页失败')

const client = new A2aClient(base)
const clientTask = await client.sendMessage('push notification', {
  taskPushNotificationConfig: { id: 'client-config', url: pushUrl, token: 'hook-token' },
})
for (let i = 0; i < 20 && notifications.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25))
if (clientTask.status.state !== 'TASK_STATE_COMPLETED' || notifications.length === 0 || notifications[0].token !== 'hook-token') throw new Error('A2A Push Notification 未送达')
const redirectTask = await client.sendMessage('push redirect', {
  taskPushNotificationConfig: { id: 'redirect-config', url: redirectUrl },
})
for (let i = 0; i < 80 && redirectBodies.filter((body) => body.includes(redirectTask.id)).length < 2; i++) {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
if (!redirectBodies.some((body) => body.includes(redirectTask.id))) throw new Error('A2A 重定向测试未发送首个请求')
if (notifications.some((notification) => notification.body.includes(redirectTask.id))) throw new Error('A2A Push 跟随重定向发送到新地址')
const burstTask = await client.sendMessage('push burst', {
  taskPushNotificationConfig: { id: 'burst-config', url: pushUrl },
})
for (let i = 0; i < 80; i++) {
  if (notifications.some((notification) => notification.body.includes(burstTask.id) && notification.body.includes('"final":true'))) break
  await new Promise((resolve) => setTimeout(resolve, 25))
}
const burstNotifications = notifications.filter((notification) => notification.body.includes(burstTask.id))
if (!burstNotifications.some((notification) => notification.body.includes('"final":true'))) throw new Error('A2A Push 终态通知未送达')
if (burstNotifications.length >= 20) throw new Error(`A2A 文本 Push 未合并: ${burstNotifications.length} 条`)
if (!(await client.getAgentCard()).name) throw new Error('A2A 客户端 Agent Card 获取失败')
if ((await client.getTask(clientTask.id, 0)).history.length !== 0 || (await client.listTasks({ pageSize: 1 })).tasks.length !== 1) throw new Error('A2A 客户端分页/历史参数失败')
const clientConfigs = await client.listPushNotificationConfigs(clientTask.id)
if (!clientConfigs.some((config) => config.id === 'client-config')) throw new Error('A2A Push 配置未保存')
const extraConfig = await client.createPushNotificationConfig(clientTask.id, { url: pushUrl })
if (!(await client.getPushNotificationConfig(clientTask.id, extraConfig.id)).taskId) throw new Error('A2A Push 配置查询失败')
await client.deletePushNotificationConfig(clientTask.id, extraConfig.id)

const clientStreamEvents = []
for await (const event of client.streamMessage('client stream')) clientStreamEvents.push(event)
if (!clientStreamEvents.some((event) => event.statusUpdate?.final)) throw new Error('A2A 客户端 SSE 解析失败')
const compatibleClient = new A2aClient('http://a2a-sse-fixture', {
  fetchImpl: async () => new Response('event: status\r\ndata: {"statusUpdate": {\r\ndata: "taskId": "crlf-task", "contextId": "ctx", "status": {"state": "TASK_STATE_COMPLETED", "timestamp": "2026-01-01T00:00:00.000Z"}, "final": true}}\r\n\r\n'),
})
const compatibleEvents = []
for await (const event of compatibleClient.streamMessage('crlf stream')) compatibleEvents.push(event)
if (compatibleEvents.length !== 1 || compatibleEvents[0].statusUpdate?.taskId !== 'crlf-task') throw new Error('A2A 客户端未兼容 CRLF/多行 SSE')
const rpcClient = new A2aClient(base, { binding: 'jsonrpc' })
const rpcTask = await rpcClient.sendMessage('jsonrpc client')
if (rpcTask.status.state !== 'TASK_STATE_COMPLETED' || (await rpcClient.getTask(rpcTask.id)).id !== rpcTask.id) throw new Error('A2A JSON-RPC 客户端调用失败')
const rpcEvents = []
for await (const event of rpcClient.streamMessage('jsonrpc stream')) rpcEvents.push(event)
if (!rpcEvents.some((event) => event.statusUpdate?.final) || (await rpcClient.listTasks({ pageSize: 1 })).tasks.length !== 1) throw new Error('A2A JSON-RPC 客户端流式/分页失败')
webhook.close()

const streamResponse = await fetch(`${base}/message:stream`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { parts: [{ kind: 'text', text: 'stream' }] } }),
})
const streamText = await streamResponse.text()
const streamEvents = streamText
  .split('\n\n')
  .filter(Boolean)
  .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as { task?: unknown; statusUpdate?: { final?: boolean } })
if (!streamResponse.ok || !streamEvents.some((event) => event.task) || !streamEvents.some((event) => event.statusUpdate?.final)) {
  throw new Error(`A2A SSE 事件不完整: ${streamText}`)
}

const rpcResponse = await fetch(`${base}/`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ListTasks', params: {} }),
})
const rpc = await rpcResponse.json() as { result?: { tasks?: unknown[] }; error?: unknown }
if (!rpc.result?.tasks || rpc.error) throw new Error(`A2A JSON-RPC 查询失败: ${JSON.stringify(rpc)}`)

const oversizedResponse = await fetch(`${base}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { role: 'ROLE_USER', parts: [{ kind: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 1024) }] } }),
})
if (oversizedResponse.status !== 413) throw new Error(`A2A 超限请求未返回 413: ${oversizedResponse.status}`)
const cardAfterOversize = await fetch(`${base}/.well-known/agent-card.json`)
if (!cardAfterOversize.ok) throw new Error('A2A 超限请求破坏了服务连接')

server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

const restoredProvider = new FakeProvider()
let restoredCalls = 0
const originalRestoredStream = restoredProvider.streamChat.bind(restoredProvider)
restoredProvider.streamChat = async function* (...args): AsyncGenerator<StreamEvent> {
  restoredCalls++
  yield* originalRestoredStream(...args)
}
const restoredServer = createA2aServer({
  provider: restoredProvider,
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskRoot: join(root, 'tasks'),
})
await new Promise<void>((resolve, reject) => {
  restoredServer.once('error', reject)
  restoredServer.listen(0, '127.0.0.1', () => resolve())
})
const restoredAddress = restoredServer.address()
if (!restoredAddress || typeof restoredAddress === 'string') throw new Error('恢复服务未监听')
const restoredCardResponse = await fetch(`http://127.0.0.1:${restoredAddress.port}/.well-known/agent-card.json`)
const restoredCard = await restoredCardResponse.json() as { capabilities?: { pushNotifications?: boolean } }
if (restoredCard.capabilities?.pushNotifications !== false) throw new Error('无白名单时 Agent Card 错误声明支持 Push')
const deniedPushResponse = await fetch(`http://127.0.0.1:${restoredAddress.port}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    message: { parts: [{ kind: 'text', text: 'denied push' }] },
    configuration: { taskPushNotificationConfig: { url: pushUrl } },
  }),
})
if (deniedPushResponse.status !== 400) throw new Error(`无白名单 Push 未拒绝: ${deniedPushResponse.status}`)
const restoredConfigsResponse = await fetch(`http://127.0.0.1:${restoredAddress.port}/tasks/${encodeURIComponent(clientTask.id)}/pushNotificationConfigs`)
const restoredConfigs = await restoredConfigsResponse.json() as { configs?: { id?: string }[] }
if (!restoredConfigsResponse.ok || !restoredConfigs.configs?.some((config) => config.id === 'client-config')) {
  throw new Error('重启后误删了历史 Push 回调配置')
}
const restoredResponse = await fetch(`http://127.0.0.1:${restoredAddress.port}/tasks/${encodeURIComponent(sent.task.id)}`)
const restored = await restoredResponse.json() as { task?: { status?: { state?: string } } }
if (!restored.task || restored.task.status?.state !== 'TASK_STATE_COMPLETED') throw new Error('A2A 重启后任务未恢复')
const restoredDuplicateResponse = await fetch(`http://127.0.0.1:${restoredAddress.port}/message:send`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: { messageId: 'a2a-dedupe-1', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hello' }] } }),
})
const restoredDuplicate = await restoredDuplicateResponse.json() as { task?: { id?: string } }
if (restoredDuplicate.task?.id !== sent.task.id) throw new Error('A2A 重启后 messageId 索引未恢复')
if (restoredCalls !== 0) throw new Error('A2A 重启后的终态幂等请求重复执行了 Agent')
restoredServer.closeAllConnections()
await new Promise<void>((resolve, reject) => restoredServer.close((error) => error ? reject(error) : resolve()))

const authServer = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  authToken: 'secret-token',
})
await new Promise<void>((resolve, reject) => {
  authServer.once('error', reject)
  authServer.listen(0, '127.0.0.1', () => resolve())
})
const authAddress = authServer.address()
if (!authAddress || typeof authAddress === 'string') throw new Error('鉴权服务未监听')
const unauthorized = await fetch(`http://127.0.0.1:${authAddress.port}/.well-known/agent-card.json`)
if (unauthorized.status !== 401) throw new Error('A2A 未授权请求未拒绝')
const authorized = await fetch(`http://127.0.0.1:${authAddress.port}/.well-known/agent-card.json`, { headers: { authorization: 'Bearer secret-token' } })
const secureCard = await authorized.json() as { securitySchemes?: unknown }
if (!authorized.ok || !secureCard.securitySchemes) throw new Error('A2A 鉴权 Agent Card 声明缺失')
authServer.closeAllConnections()
await new Promise<void>((resolve, reject) => authServer.close((error) => error ? reject(error) : resolve()))

rmSync(root, { recursive: true, force: true })
console.log('a2a_test passed')
