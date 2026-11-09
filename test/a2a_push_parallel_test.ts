import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import type { A2AStreamResponse } from '../src/a2a/types.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function waitFor(condition: () => boolean, message: string, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

class GatedProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly parallel = gate()
  readonly orderedStart = gate()
  readonly orderedSecond = gate()
  readonly orderedFinish = gate()
  readonly saturationStart = gate()

  async *streamChat(messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    if (messages.some((message) => message.content === 'parallel')) {
      await this.parallel.promise
      yield { type: 'done' }
      return
    }
    if (messages.some((message) => message.content === 'saturation')) {
      await this.saturationStart.promise
      for (let index = 0; index < 36; index++) {
        yield { type: 'text', text: String(index % 10) }
        await new Promise((resolve) => setTimeout(resolve, 110))
      }
      yield { type: 'done' }
      return
    }
    await this.orderedStart.promise
    yield { type: 'text', text: 'first' }
    await this.orderedSecond.promise
    yield { type: 'text', text: 'second' }
    await this.orderedFinish.promise
    yield { type: 'done' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-push-parallel-'))
const provider = new GatedProvider()
const parallelRelease = gate()
const slowRelease = gate()
const saturationRelease = gate()
const parallelEntered = new Set<string>()
let parallelActive = 0
let parallelPeak = 0
const slowEvents: A2AStreamResponse[] = []
const fastEvents: A2AStreamResponse[] = []
const saturationSlowEvents: A2AStreamResponse[] = []
const saturationFastEvents: A2AStreamResponse[] = []
const webhook = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk.toString() })
  req.on('end', async () => {
    const event = JSON.parse(body) as A2AStreamResponse
    if (req.url?.startsWith('/parallel-')) {
      parallelEntered.add(req.url)
      parallelActive++
      parallelPeak = Math.max(parallelPeak, parallelActive)
      await parallelRelease.promise
      parallelActive--
    } else if (req.url === '/slow') {
      slowEvents.push(event)
      if (event.statusUpdate?.status.state === 'TASK_STATE_WORKING') await slowRelease.promise
    } else if (req.url === '/fast') {
      fastEvents.push(event)
    } else if (req.url === '/saturation-slow') {
      saturationSlowEvents.push(event)
      if (event.statusUpdate?.status.state === 'TASK_STATE_WORKING') await saturationRelease.promise
    } else if (req.url === '/saturation-fast') {
      saturationFastEvents.push(event)
    }
    res.writeHead(204)
    res.end()
  })
})

const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
try {
  await new Promise<void>((resolve, reject) => {
    webhook.once('error', reject)
    webhook.listen(0, '127.0.0.1', resolve)
  })
  const webhookAddress = webhook.address()
  if (!webhookAddress || typeof webhookAddress === 'string') throw new Error('Push 测试回调未监听')
  const pushBase = `http://127.0.0.1:${webhookAddress.port}`
  const pushUrls = Array.from({ length: 5 }, (_, index) => `${pushBase}/parallel-${index}`)
  pushUrls.push(`${pushBase}/slow`, `${pushBase}/fast`, `${pushBase}/saturation-slow`, `${pushBase}/saturation-fast`)
  const testServer = createA2aServer({
    provider,
    registry: new ToolRegistry(),
    engine,
    cwd: process.cwd(),
    taskRoot: join(root, 'tasks'),
    pushAllowedUrls: pushUrls,
  })
  try {
    await new Promise<void>((resolve, reject) => {
      testServer.once('error', reject)
      testServer.listen(0, '127.0.0.1', resolve)
    })
    const address = testServer.address()
    if (!address || typeof address === 'string') throw new Error('A2A Push 测试服务未监听')
    const base = `http://127.0.0.1:${address.port}`
    const headers = { 'content-type': 'application/a2a+json' }
    const createTask = async (content: string): Promise<string> => {
      const response = await fetch(`${base}/message:send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: { parts: [{ kind: 'text', text: content }] }, configuration: { returnImmediately: true } }),
      })
      const body = await response.json() as { task?: { id?: string } }
      if (!response.ok || !body.task?.id) throw new Error(`Push 测试任务创建失败: ${content}`)
      return body.task.id
    }
    const addConfig = async (taskId: string, id: string): Promise<void> => {
      const response = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, url: `${pushBase}/${id}` }),
      })
      if (!response.ok) throw new Error(`Push 测试配置创建失败: ${id} ${response.status}`)
    }

    const parallelTask = await createTask('parallel')
    for (let index = 0; index < 5; index++) await addConfig(parallelTask, `parallel-${index}`)
    provider.parallel.release()
    await waitFor(() => parallelEntered.size === 4, 'Push 未并行启动 4 个回调')
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (parallelEntered.size !== 4 || parallelPeak !== 4) throw new Error(`Push 并发上限失效: entered=${parallelEntered.size}, peak=${parallelPeak}`)
    parallelRelease.release()
    await waitFor(() => parallelEntered.size === 5 && parallelActive === 0, 'Push 第 5 个回调未在槽位释放后完成')

    const orderedTask = await createTask('ordered')
    await addConfig(orderedTask, 'slow')
    await addConfig(orderedTask, 'fast')
    provider.orderedStart.release()
    await waitFor(() => slowEvents.some((event) => event.statusUpdate?.status.state === 'TASK_STATE_WORKING'), '慢回调未收到首条进度')
    provider.orderedSecond.release()
    await waitFor(() => fastEvents.filter((event) => event.statusUpdate?.status.state === 'TASK_STATE_WORKING').length >= 2, '第二条进度未进入 Push 队列')
    provider.orderedFinish.release()
    await waitFor(() => fastEvents.some((event) => event.statusUpdate?.final), '快回调终态被慢回调阻塞')
    if (slowEvents.some((event) => event.statusUpdate?.final)) throw new Error('同一慢回调终态越过了首条进度')
    slowRelease.release()
    await waitFor(() => slowEvents.some((event) => event.statusUpdate?.final), '慢回调未在前序事件结束后收到终态')
    const slowWorking = slowEvents.filter((event) => event.statusUpdate?.status.state === 'TASK_STATE_WORKING')
    if (slowWorking.length !== 1) throw new Error(`慢回调收到过期进度: ${slowWorking.length}`)
    if (slowEvents.at(-1)?.statusUpdate?.final !== true) throw new Error('慢回调事件顺序错误')

    const saturationTask = await createTask('saturation')
    await addConfig(saturationTask, 'saturation-slow')
    await addConfig(saturationTask, 'saturation-fast')
    provider.saturationStart.release()
    await waitFor(() => saturationSlowEvents.some((event) => event.statusUpdate?.status.state === 'TASK_STATE_WORKING'), '积压测试的慢回调未收到进度')
    await waitFor(() => saturationFastEvents.some((event) => event.statusUpdate?.final), '积压测试的快回调未收到终态', 800)
    const fastProgressCount = saturationFastEvents.filter((event) => event.statusUpdate?.status.state === 'TASK_STATE_WORKING').length
    if (fastProgressCount < 33) throw new Error(`积压测试未超过原队列上限: ${fastProgressCount}`)
    const fastArtifactIndex = saturationFastEvents.findIndex((event) => event.artifactUpdate)
    const fastTerminalIndex = saturationFastEvents.findIndex((event) => event.statusUpdate?.final)
    if (fastArtifactIndex < 0 || fastArtifactIndex >= fastTerminalIndex) throw new Error('慢回调积压导致快回调丢失产物或事件乱序')
    saturationRelease.release()
    await waitFor(() => saturationSlowEvents.some((event) => event.statusUpdate?.final), '慢回调积压释放后未收到终态')
    if (!saturationSlowEvents.some((event) => event.artifactUpdate)) throw new Error('慢回调积压导致自身丢失产物')
  } finally {
    testServer.closeAllConnections()
    await new Promise<void>((resolve) => testServer.close(() => resolve()))
  }
} finally {
  parallelRelease.release()
  slowRelease.release()
  saturationRelease.release()
  webhook.closeAllConnections()
  await new Promise<void>((resolve) => webhook.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
}

console.log('a2a_push_parallel_test passed')
