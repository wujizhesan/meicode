import type { StreamEvent } from './types.ts'

const DEFAULT_IDLE_TIMEOUT_MS = 30_000

export interface ToolCallAccumulator {
  id?: string
  name?: string
  args: string[]
}

export interface LinkedAbortController {
  controller: AbortController
  dispose: () => void
}

export function linkAbortSignal(signal?: AbortSignal): LinkedAbortController {
  const controller = new AbortController()
  const abort = () => controller.abort()

  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })

  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', abort),
  }
}

export async function getResponseErrorDetail(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`
  const reader = response.body?.getReader()
  if (!reader) return detail
  const decoder = new TextDecoder()
  let body = ''
  let bytesRead = 0
  try {
    while (body.length < 500 && bytesRead < 4096) {
      const result = await reader.read()
      if (result.done) break
      const remaining = 4096 - bytesRead
      const value = result.value.subarray(0, remaining)
      bytesRead += value.length
      body += decoder.decode(value, { stream: true })
      if (value.length < result.value.length) break
    }
    body += decoder.decode()
    if (body) detail += `: ${body.slice(0, 500)}`
  } catch {
    return detail
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return detail
}

export function drainToolCalls(accumulators: Map<number, ToolCallAccumulator>): StreamEvent[] {
  const events: StreamEvent[] = []
  for (const [, accumulator] of [...accumulators.entries()].sort(([a], [b]) => a - b)) {
    if (!accumulator.id || !accumulator.name) {
      events.push({ type: 'error', message: '工具调用不完整（缺少 id 或 name）' })
      continue
    }
    const args = accumulator.args.join('')
    try {
      events.push({
        type: 'tool_call',
        id: accumulator.id,
        name: accumulator.name,
        arguments: JSON.parse(args || '{}') as Record<string, unknown>,
      })
    } catch {
      events.push({
        type: 'error',
        message: `工具参数解析失败 (${accumulator.name}): ${args.slice(0, 100)}`,
      })
    }
  }
  accumulators.clear()
  return events
}

export async function* readResponseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const abort = () => {
    void reader.cancel()
  }

  signal?.addEventListener('abort', abort, { once: true })
  let waitingSince: number | undefined
  let timedOut = false
  const watchdog = setInterval(() => {
    if (waitingSince !== undefined && Date.now() - waitingSince >= idleTimeoutMs) {
      timedOut = true
      void reader.cancel().catch(() => undefined)
    }
  }, Math.min(Math.max(idleTimeoutMs, 1), 1000))
  try {
    if (signal?.aborted) await reader.cancel()
    while (true) {
      timedOut = false
      waitingSince = Date.now()
      let result: Awaited<ReturnType<typeof reader.read>>
      try {
        result = await reader.read()
      } catch (error) {
        if (timedOut) throw new Error(`流式读取超时（${idleTimeoutMs / 1000}s 无数据）`)
        throw error
      } finally {
        waitingSince = undefined
      }
      if (timedOut) throw new Error(`流式读取超时（${idleTimeoutMs / 1000}s 无数据）`)
      const { done, value } = result
      if (done) return
      yield value
    }
  } finally {
    clearInterval(watchdog)
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
  }
}
