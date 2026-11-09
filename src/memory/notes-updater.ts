import type { ChatMessage, Provider } from '../provider/types.ts'
import { linkAbortSignal, type LinkedAbortController } from '../provider/stream.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import { updateNotes } from './notes.ts'

export function createNotesUpdater() {
  let current: LinkedAbortController | null = null

  const cancel = (): void => {
    const request = current
    current = null
    request?.dispose()
    request?.controller.abort()
  }

  const start = (provider: Provider, recent: ChatMessage[], opts: Parameters<typeof updateNotes>[2]): void => {
    cancel()
    if (opts.signal?.aborted) return
    const request = linkAbortSignal(opts.signal)
    current = request
    void resolveOnAbort(
      () => updateNotes(provider, recent, { ...opts, signal: request.controller.signal }),
      request.controller.signal,
      undefined,
    ).catch(() => {}).finally(() => {
      request.dispose()
      if (current === request) current = null
    })
  }

  return { start, cancel }
}
