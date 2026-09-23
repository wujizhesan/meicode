import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { A2ATask } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

class OrderedStore extends A2aTaskStore {
  override loadMetadata() {
    return super.loadMetadata().sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  }
}

class IdleProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'done' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-pagination-'))
const realNow = Date.now
const initialNow = realNow()
let clockNow = initialNow
let server: ReturnType<typeof createA2aServer> | undefined

try {
  const store = new OrderedStore(join(root, 'tasks'))
  for (const id of ['cursor-a', 'cursor-b', 'cursor-c', 'cursor-d']) {
    const timestamp = new Date(initialNow - (id === 'cursor-a' || id === 'cursor-b' ? 9_000 : 0)).toISOString()
    const task: A2ATask = {
      id,
      contextId: 'pagination-context',
      status: { state: 'TASK_STATE_COMPLETED', timestamp },
      history: [],
      artifacts: [],
    }
    store.save(task)
  }
  Date.now = () => clockNow
  const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
  engine.loadAll()
  server = createA2aServer({
    provider: new IdleProvider(),
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskStore: store,
    taskTtlMs: 10_000,
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A2A pagination server 未监听')
  const base = `http://127.0.0.1:${address.port}`
  const firstResponse = await fetch(`${base}/tasks?pageSize=2`)
  const first = await firstResponse.json() as { tasks?: A2ATask[]; nextPageToken?: string }
  if (!firstResponse.ok || first.tasks?.map((task) => task.id).join(',') !== 'cursor-a,cursor-b' || !first.nextPageToken) throw new Error('A2A 分页第一页错误')

  clockNow += 2_000
  const secondResponse = await fetch(`${base}/tasks?pageSize=2&pageToken=${encodeURIComponent(first.nextPageToken)}`)
  const second = await secondResponse.json() as { tasks?: A2ATask[]; totalSize?: number; nextPageToken?: string }
  if (!secondResponse.ok || second.tasks?.map((task) => task.id).join(',') !== 'cursor-c,cursor-d' || second.totalSize !== 2 || second.nextPageToken) {
    throw new Error('A2A 翻页时清理前页任务导致漏项')
  }
} finally {
  Date.now = realNow
  if (server) await closeHttpServer(server)
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_pagination_test passed')
