import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2ATask } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class CountingStore extends A2aTaskStore {
  readonly loadedIds: string[] = []

  override loadById(taskId: string) {
    this.loadedIds.push(taskId)
    return super.loadById(taskId)
  }
}

class IdleProvider implements Provider {
  readonly protocol = 'openai' as const
  calls = 0

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    this.calls++
    yield { type: 'done' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-cold-'))
const taskRoot = join(root, 'tasks')
const store = new CountingStore(taskRoot)
const loadedCount = (): number => store.loadedIds.length
const provider = new IdleProvider()
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
let server: ReturnType<typeof createServer> | undefined

try {
  const seed = (id: string, messageId: string, timestamp: string): void => {
    const task: A2ATask = {
      id,
      contextId: `context-${id}`,
      status: { state: 'TASK_STATE_COMPLETED', timestamp },
      history: [{ messageId, role: 'ROLE_USER', parts: [{ kind: 'text', text: id }] }],
      artifacts: [],
    }
    store.save(task)
  }
  const current = new Date().toISOString()
  for (let index = 0; index < 40; index++) seed(`cold-${String(index).padStart(3, '0')}`, `message-${index}`, current)
  seed('expired', 'expired-message', new Date(Date.now() - 120_000).toISOString())

  const changedId = 'cold-000'
  const recordFile = join(taskRoot, 'records', `${createHash('sha256').update(changedId).digest('hex')}.json`)
  const changed = JSON.parse(readFileSync(recordFile, 'utf8')) as { task: A2ATask }
  changed.task.contextId = 'context-updated-after-index-write'
  writeFileSync(recordFile, JSON.stringify(changed), 'utf8')

  server = createA2aServer({
    provider,
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: store,
    taskTtlMs: 60_000,
    maxCachedCompletedTasks: 2,
  })
  if (loadedCount() !== 0) throw new Error('启动时读取了无待投递项的完整终态任务')
  if (store.loadMetadata().find((item) => item.id === changedId)?.contextId !== changed.task.contextId) throw new Error('正文变更后轻量索引未重建')
  if (store.loadMetadata().some((item) => item.id === 'expired')) throw new Error('过期冷任务未在启动时清理')

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('冷任务测试服务未监听')
  const base = `http://127.0.0.1:${address.port}`
  const healthResponse = await fetch(`${base}/health`)
  const health = await healthResponse.json() as { tasks?: number }
  if (health.tasks !== 40) throw new Error(`冷任务总数错误: ${health.tasks}`)
  const listResponse = await fetch(`${base}/tasks?pageSize=3`)
  const list = await listResponse.json() as { tasks?: A2ATask[]; totalSize?: number; nextPageToken?: string }
  if (!listResponse.ok || list.totalSize !== 40 || list.tasks?.length !== 3 || !list.nextPageToken) throw new Error('冷任务列表分页结果错误')
  if (loadedCount() !== 3) throw new Error(`列表读取了非当前页任务: ${loadedCount()}`)
  const cachedId = list.tasks[2].id
  const cachedResponse = await fetch(`${base}/tasks/${cachedId}`)
  if (!cachedResponse.ok || loadedCount() !== 3) throw new Error('已缓存的冷任务被重复读取')
  const evictedResponse = await fetch(`${base}/tasks/${list.tasks[0].id}`)
  if (!evictedResponse.ok || loadedCount() !== 4) throw new Error('冷任务缓存未限制为两条')

  const headers = { 'content-type': 'application/a2a+json' }
  const duplicate = await fetch(`${base}/message:send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { messageId: 'message-0', parts: [{ kind: 'text', text: 'duplicate' }] } }),
  })
  const duplicateBody = await duplicate.json() as { task?: A2ATask }
  if (!duplicate.ok || duplicateBody.task?.id !== changedId || duplicateBody.task.contextId !== changed.task.contextId || provider.calls !== 0) throw new Error('冷任务 messageId 幂等语义丢失')
  const reused = await fetch(`${base}/message:send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { messageId: 'expired-message', parts: [{ kind: 'text', text: 'reused' }] } }),
  })
  const reusedBody = await reused.json() as { task?: A2ATask }
  if (!reused.ok || !reusedBody.task?.id || reusedBody.task.id === 'expired') throw new Error('过期冷任务的 messageId 未释放')
} finally {
  if (server) await closeHttpServer(server)
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_cold_tasks_test passed')
