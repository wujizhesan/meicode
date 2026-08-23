import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import { A2aClient } from '../src/a2a/client.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    if (_messages.some((message) => message.content === 'immediate')) await new Promise((resolve) => setTimeout(resolve, 50))
    yield { type: 'text', text: 'A2A response' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_a2a')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const server = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  baseUrl: 'http://127.0.0.1',
  taskRoot: join(root, 'tasks'),
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
const card = await cardResponse.json() as { capabilities?: { streaming?: boolean; pushNotifications?: boolean }; supportedInterfaces?: unknown[] }
if (!card.capabilities?.streaming || !card.capabilities.pushNotifications || card.supportedInterfaces?.length !== 2) throw new Error('Agent Card 能力声明不完整')

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

const notifications: { body: string; token?: string }[] = []
const webhook = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk.toString()))
  req.on('end', () => {
    notifications.push({ body, token: typeof req.headers['x-a2a-notification-token'] === 'string' ? req.headers['x-a2a-notification-token'] : undefined })
    res.writeHead(204)
    res.end()
  })
})
await new Promise<void>((resolve, reject) => {
  webhook.once('error', reject)
  webhook.listen(0, '127.0.0.1', () => resolve())
})
const webhookAddress = webhook.address()
if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('Webhook 未监听')
const client = new A2aClient(base)
const clientTask = await client.sendMessage('push notification', {
  taskPushNotificationConfig: { id: 'client-config', url: `http://127.0.0.1:${webhookAddress.port}/events`, token: 'hook-token' },
})
for (let i = 0; i < 20 && notifications.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25))
if (clientTask.status.state !== 'TASK_STATE_COMPLETED' || notifications.length === 0 || notifications[0].token !== 'hook-token') throw new Error('A2A Push Notification 未送达')
if (!(await client.getAgentCard()).name) throw new Error('A2A 客户端 Agent Card 获取失败')
if ((await client.getTask(clientTask.id, 0)).history.length !== 0 || (await client.listTasks({ pageSize: 1 })).tasks.length !== 1) throw new Error('A2A 客户端分页/历史参数失败')
const clientConfigs = await client.listPushNotificationConfigs(clientTask.id)
if (!clientConfigs.some((config) => config.id === 'client-config')) throw new Error('A2A Push 配置未保存')
const extraConfig = await client.createPushNotificationConfig(clientTask.id, { url: `http://127.0.0.1:${webhookAddress.port}/events` })
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

server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

const restoredServer = createA2aServer({
  provider: new FakeProvider(),
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
const restoredResponse = await fetch(`http://127.0.0.1:${restoredAddress.port}/tasks/${encodeURIComponent(sent.task.id)}`)
const restored = await restoredResponse.json() as { task?: { status?: { state?: string } } }
if (!restored.task || restored.task.status?.state !== 'TASK_STATE_COMPLETED') throw new Error('A2A 重启后任务未恢复')
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
