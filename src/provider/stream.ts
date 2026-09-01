import { withIdleTimeout } from './timeout.ts'
import type { StreamEvent } from './types.ts'

const DEFAULT_IDLE_TIMEOUT_MS = 30_000

export interface ToolCallAccumulator {
  id?: string
  name?: string
  args: string
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
  try {
    const body = await response.text()
    if (body) detail += `: ${body.slice(0, 500)}`
  } catch {
    return detail
  }
  return detail
}

export function drainToolCalls(accumulators: Map<number, ToolCallAccumulator>): StreamEvent[] {
  const events: StreamEvent[] = []
  for (const accumulator of accumulators.values()) {
    if (!accumulator.id || !accumulator.name) {
      events.push({ type: 'error', message: '工具调用不完整（缺少 id 或 name）' })
      continue
    }
    try {
      events.push({
        type: 'tool_call',
        id: accumulator.id,
        name: accumulator.name,
        arguments: JSON.parse(accumulator.args || '{}') as Record<string, unknown>,
      })
    } catch {
      events.push({
        type: 'error',
        message: `工具参数解析失败 (${accumulator.name}): ${accumulator.args.slice(0, 100)}`,
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
  try {
    if (signal?.aborted) await reader.cancel()
    while (true) {
      const { done, value } = await withIdleTimeout(reader.read(), idleTimeoutMs)
      if (done) return
      yield value
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
  }
}
