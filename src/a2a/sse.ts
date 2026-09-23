import { TERMINAL_STATES } from './protocol.ts'
import type { A2AStreamResponse } from './types.ts'

export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024
const SSE_DRAIN_TIMEOUT_MS = 10_000

export type SseCloseReason = 'complete' | 'closed' | 'overflow' | 'timeout' | 'write-error'

export interface SseWritable {
  readonly writableEnded: boolean
  readonly writableLength: number
  readonly destroyed: boolean
  write(chunk: string): boolean
  end(): void
  destroy(): void
  on(event: 'close', listener: () => void): unknown
  once(event: 'drain', listener: () => void): unknown
  off(event: 'close' | 'drain', listener: () => void): unknown
}

interface PendingFrame {
  data: string
  bytes: number
}

export function createA2aSseWriter(
  response: SseWritable,
  rpcId: string | number | null | undefined,
  onClose: (reason: SseCloseReason) => void,
  options: { maxBufferBytes?: number; drainTimeoutMs?: number } = {},
): { write: (event: A2AStreamResponse) => void; finish: () => void; isClosed: () => boolean } {
  const maxBufferBytes = options.maxBufferBytes ?? MAX_SSE_BUFFER_BYTES
  const drainTimeoutMs = options.drainTimeoutMs ?? SSE_DRAIN_TIMEOUT_MS
  const pending: PendingFrame[] = []
  let head = 0
  let pendingBytes = 0
  let blocked = false
  let ending = false
  let closed = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined

  function cleanup(reason: SseCloseReason): void {
    if (closed) return
    closed = true
    if (drainTimer) clearTimeout(drainTimer)
    response.off('drain', onDrain)
    response.off('close', onResponseClose)
    pending.length = 0
    head = 0
    pendingBytes = 0
    onClose(reason)
  }

  function disconnect(reason: SseCloseReason): void {
    cleanup(reason)
    if (!response.destroyed) response.destroy()
  }

  function onResponseClose(): void {
    cleanup('closed')
  }

  function onDrain(): void {
    if (closed) return
    if (drainTimer) clearTimeout(drainTimer)
    drainTimer = undefined
    blocked = false
    flush()
  }

  function flush(): void {
    if (closed || blocked) return
    while (head < pending.length) {
      const frame = pending[head++]
      pendingBytes -= frame.bytes
      if (head === pending.length) {
        pending.length = 0
        head = 0
      }
      let canContinue: boolean
      try {
        canContinue = response.write(frame.data)
      } catch {
        disconnect('write-error')
        return
      }
      if (!canContinue) {
        blocked = true
        response.once('drain', onDrain)
        drainTimer = setTimeout(() => disconnect('timeout'), drainTimeoutMs)
        drainTimer.unref?.()
        return
      }
    }
    if (ending) {
      cleanup('complete')
      if (!response.writableEnded && !response.destroyed) response.end()
    }
  }

  function write(event: A2AStreamResponse): void {
    if (closed || ending) return
    if (response.writableEnded || response.destroyed) {
      cleanup('closed')
      return
    }
    const payload = rpcId === undefined ? event : { jsonrpc: '2.0', id: rpcId, result: event }
    const data = `data: ${JSON.stringify(payload)}\n\n`
    const bytes = Buffer.byteLength(data)
    if (pendingBytes + response.writableLength + bytes > maxBufferBytes) {
      disconnect('overflow')
      return
    }
    pending.push({ data, bytes })
    pendingBytes += bytes
    if (event.statusUpdate?.final || (event.task && TERMINAL_STATES.has(event.task.status.state))) ending = true
    flush()
  }

  function finish(): void {
    if (closed) return
    ending = true
    flush()
  }

  response.on('close', onResponseClose)
  return { write, finish, isClosed: () => closed }
}
