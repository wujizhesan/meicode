import { performance } from 'node:perf_hooks'
import { createA2aServer } from '../src/a2a.ts'
import type { A2aTaskStore, A2aTaskMetadata } from '../src/a2a/store.ts'
import type { A2AStoredTask, A2ATask } from '../src/a2a/types.ts'
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

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

function createStore(count: number): A2aTaskStore {
  const timestamp = new Date().toISOString()
  const metadata: A2aTaskMetadata[] = Array.from({ length: count }, (_, index) => {
    const taskNumber = (index * 8191) % count
    const id = `bench-${String(taskNumber).padStart(6, '0')}`
    return { id, contextId: taskNumber < 100 ? 'bench-small-context' : 'bench-context', state: 'TASK_STATE_COMPLETED', timestamp, messageIds: [], pendingPushDeliveries: 0 }
  })
  return {
    loadMetadata: () => metadata,
    loadById: (id: string): A2AStoredTask | undefined => {
      if (!/^bench-\d{6}$/.test(id)) return undefined
      const index = Number(id.slice(6))
      if (index >= count) return undefined
      const task: A2ATask = { id, contextId: index < 100 ? 'bench-small-context' : 'bench-context', status: { state: 'TASK_STATE_COMPLETED', timestamp }, history: [], artifacts: [] }
      return { task, pushNotificationConfigs: [], pendingPushDeliveries: [] }
    },
    save: () => { throw new Error('基准测试不应写入任务') },
    remove: () => { throw new Error('基准测试不应删除任务') },
  } as unknown as A2aTaskStore
}

async function request(url: string): Promise<{ durationMs: number; result: { tasks: A2ATask[]; totalSize: number; nextPageToken?: string } }> {
  const started = performance.now()
  const response = await fetch(url)
  const result = await response.json() as { tasks: A2ATask[]; totalSize: number; nextPageToken?: string }
  if (!response.ok) throw new Error(`A2A 列表请求失败: ${response.status}`)
  return { durationMs: performance.now() - started, result }
}

const counts = process.argv.slice(2).length > 0 ? process.argv.slice(2).map(Number) : [1_000, 10_000, 50_000]
if (counts.some((count) => !Number.isSafeInteger(count) || count < 100 || count > 100_000)) throw new Error('任务数必须是 100 到 100000 的整数')

for (const count of counts) {
  const started = performance.now()
  const server = createA2aServer({
    provider: new IdleProvider(),
    registry: new ToolRegistry(),
    engine: new RuleEngine('', '', ''),
    cwd: process.cwd(),
    taskStore: createStore(count),
  })
  const startupMs = performance.now() - started
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('A2A 基准服务未监听')
    const firstUrl = `http://127.0.0.1:${address.port}/tasks?pageSize=50`
    const first = await request(firstUrl)
    if (first.result.totalSize !== count || first.result.tasks.length !== 50 || !first.result.nextPageToken) throw new Error('A2A 基准第一页结果无效')
    const nextUrl = `${firstUrl}&pageToken=${encodeURIComponent(first.result.nextPageToken)}`
    const next = await request(nextUrl)
    if (next.result.tasks.length !== 50 || next.result.tasks[0].id === first.result.tasks[0].id) throw new Error('A2A 基准第二页结果无效')
    const filteredUrl = `${firstUrl}&contextId=bench-small-context`
    const filtered = await request(filteredUrl)
    if (filtered.result.totalSize !== 100 || filtered.result.tasks.length !== 50) throw new Error('A2A 基准筛选结果无效')
    for (let index = 0; index < 5; index++) {
      await request(firstUrl)
      await request(nextUrl)
      await request(filteredUrl)
    }
    const firstTimes: number[] = []
    const nextTimes: number[] = []
    const filteredTimes: number[] = []
    for (let index = 0; index < 25; index++) {
      firstTimes.push((await request(firstUrl)).durationMs)
      nextTimes.push((await request(nextUrl)).durationMs)
      filteredTimes.push((await request(filteredUrl)).durationMs)
    }
    console.log(`${count} tasks | startup ${startupMs.toFixed(1)} ms | first p50/p95 ${percentile(firstTimes, 0.5).toFixed(1)}/${percentile(firstTimes, 0.95).toFixed(1)} ms | next p50/p95 ${percentile(nextTimes, 0.5).toFixed(1)}/${percentile(nextTimes, 0.95).toFixed(1)} ms | filtered p50/p95 ${percentile(filteredTimes, 0.5).toFixed(1)}/${percentile(filteredTimes, 0.95).toFixed(1)} ms`)
  } finally {
    await closeHttpServer(server)
  }
}
