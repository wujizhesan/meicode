import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2ATask } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: 'completed' }
    yield { type: 'done' }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-quota-'))
const pushUrl = 'http://127.0.0.1:49152/hook'
const headers = { 'content-type': 'application/a2a+json' }
const taskStore = new A2aTaskStore(join(root, 'tasks'))
const legacyTask: A2ATask = {
  id: 'legacy-push-task',
  contextId: 'legacy-context',
  status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
  history: [],
  artifacts: [],
}
taskStore.save(legacyTask, Array.from({ length: 9 }, (_, index) => ({ id: `legacy-${index}`, taskId: legacyTask.id, url: pushUrl })))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const server = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine,
  cwd: process.cwd(),
  taskStore,
  pushAllowedUrls: [pushUrl],
})

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A2A Push 配额测试服务未监听')
  const base = `http://127.0.0.1:${address.port}`

  const createConfig = (taskId: string, id: string, token?: string): Promise<Response> => fetch(`${base}/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, url: pushUrl, ...(token ? { token } : {}) }),
  })
  const listConfigs = async (taskId: string): Promise<{ id: string; token?: string }[]> => {
    const response = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`)
    const body = await response.json() as { configs?: { id: string; token?: string }[] }
    assert(response.ok && body.configs, 'Push 配置列表查询失败')
    return body.configs
  }

  const sent = await fetch(`${base}/message:send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { messageId: 'push-quota-message', parts: [{ kind: 'text', text: 'new task' }] } }),
  })
  const sentBody = await sent.json() as { task?: { id?: string } }
  assert(sent.ok && sentBody.task?.id, 'Push 配额测试任务创建失败')
  const taskId = sentBody.task.id

  for (let index = 0; index < 8; index++) {
    const response = await createConfig(taskId, `push-${index}`)
    assert(response.ok, `第 ${index + 1} 个 Push 配置未被接受`)
  }
  assert((await createConfig(taskId, 'push-ninth')).status === 429, 'REST 新增超额 Push 配置未返回 429')

  const rpcRejected = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'CreateTaskPushNotificationConfig', params: { taskId, config: { id: 'push-rpc-extra', url: pushUrl } } }),
  })
  assert(rpcRejected.status === 429, 'JSON-RPC 新增超额 Push 配置未返回 429')

  const replaced = await createConfig(taskId, 'push-0', 'rest-replaced')
  assert(replaced.ok, '达到上限后未允许 REST 替换同 ID 配置')
  assert((await listConfigs(taskId)).length === 8, '替换同 ID 配置增加了数量')

  const retryRejected = await fetch(`${base}/message:send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: { messageId: 'push-quota-message', parts: [{ kind: 'text', text: 'retry' }] },
      configuration: { taskPushNotificationConfig: { id: 'push-retry-extra', url: pushUrl } },
    }),
  })
  assert(retryRejected.status === 429, '消息重试绕过了 Push 配置上限')
  assert((await listConfigs(taskId)).length === 8, '拒绝后配置数量发生变化')

  const retryReplaced = await fetch(`${base}/message:send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: { messageId: 'push-quota-message', parts: [{ kind: 'text', text: 'retry' }] },
      configuration: { taskPushNotificationConfig: { id: 'push-0', url: pushUrl, token: 'retry-replaced' } },
    }),
  })
  const retryBody = await retryReplaced.json() as { task?: { id?: string } }
  assert(retryReplaced.ok && retryBody.task?.id === taskId, '消息重试未允许替换同 ID 配置')
  assert((await listConfigs(taskId)).find((config) => config.id === 'push-0')?.token === 'retry-replaced', '消息重试替换未持久化')

  const deleted = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs/push-1`, { method: 'DELETE' })
  assert(deleted.ok, '删除 Push 配置失败')
  const rpcAdded = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'CreateTaskPushNotificationConfig', params: { taskId, config: { id: 'push-rpc-new', url: pushUrl } } }),
  })
  assert(rpcAdded.ok && (await listConfigs(taskId)).length === 8, '删除后未释放 Push 配置名额')

  assert((await listConfigs(legacyTask.id)).length === 9, '恢复时裁掉了旧的超额 Push 配置')
  assert((await createConfig(legacyTask.id, 'legacy-new')).status === 429, '旧超额任务仍允许新增配置')
  assert((await createConfig(legacyTask.id, 'legacy-0', 'legacy-replaced')).ok, '旧超额任务不能替换已有配置')
  assert(taskStore.load().find((item) => item.task.id === legacyTask.id)?.pushNotificationConfigs.length === 9, '更新旧配置时裁掉了历史配置')
  for (const id of ['legacy-1', 'legacy-2']) {
    const response = await fetch(`${base}/tasks/${encodeURIComponent(legacyTask.id)}/pushNotificationConfigs/${id}`, { method: 'DELETE' })
    assert(response.ok, '旧任务删除配置失败')
  }
  assert((await createConfig(legacyTask.id, 'legacy-new')).ok, '旧任务降到上限以下后仍不能新增配置')
  assert((await listConfigs(legacyTask.id)).length === 8, '旧任务新增后配置数量异常')
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

const disabledRoot = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-disabled-'))
const disabledEngine = new RuleEngine(join(disabledRoot, 'user.yaml'), join(disabledRoot, 'project.yaml'), join(disabledRoot, 'local.yaml'))
disabledEngine.loadAll()
const disabledServer = createA2aServer({
  provider: new FakeProvider(),
  registry: new ToolRegistry(),
  engine: disabledEngine,
  cwd: process.cwd(),
  pushAllowedUrls: [pushUrl],
  maxPushConfigsPerTask: 0,
})
try {
  await new Promise<void>((resolve, reject) => {
    disabledServer.once('error', reject)
    disabledServer.listen(0, '127.0.0.1', resolve)
  })
  const address = disabledServer.address()
  if (!address || typeof address === 'string') throw new Error('A2A Push 禁用测试服务未监听')
  const base = `http://127.0.0.1:${address.port}`
  const card = await fetch(`${base}/.well-known/agent-card.json`).then((response) => response.json()) as { capabilities?: { pushNotifications?: boolean } }
  assert(card.capabilities?.pushNotifications === false, '上限为零时 Agent Card 仍声明支持 Push')
  const rejected = await fetch(`${base}/message:send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: { parts: [{ kind: 'text', text: 'blocked new task' }] },
      configuration: { taskPushNotificationConfig: { id: 'blocked', url: pushUrl } },
    }),
  })
  assert(rejected.status === 429, '新任务附带 Push 配置未遵守零上限')
  const tasks = await fetch(`${base}/tasks`).then((response) => response.json()) as { totalSize?: number }
  assert(tasks.totalSize === 0, '拒绝初始 Push 配置后仍创建了任务')
} finally {
  disabledServer.closeAllConnections()
  await new Promise<void>((resolve) => disabledServer.close(() => resolve()))
  rmSync(disabledRoot, { recursive: true, force: true })
}

console.log('a2a_push_quota_test passed')
