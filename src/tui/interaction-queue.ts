export type InteractionListener<Request> = (pending: Request[]) => void

interface InteractionEntry<Request, Response> {
  request: Request
  resolve(response: Response): void
  cleanup(): void
}

export interface InteractionAbort<Response> {
  signal: AbortSignal
  response: Response
}

export class InteractionQueue<Request, Response> {
  private entries: InteractionEntry<Request, Response>[] = []
  private listeners = new Set<InteractionListener<Request>>()

  request(request: Request, abort?: InteractionAbort<Response>): Promise<Response> {
    if (abort?.signal.aborted) return Promise.resolve(abort.response)
    return new Promise((resolve) => {
      const entry: InteractionEntry<Request, Response> = { request, resolve, cleanup: () => {} }
      if (abort) {
        const onAbort = (): void => { this.resolveEntry(entry, abort.response) }
        abort.signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = () => abort.signal.removeEventListener('abort', onAbort)
      }
      this.entries.push(entry)
      this.emit()
      if (abort?.signal.aborted) this.resolveEntry(entry, abort.response)
    })
  }

  resolveNext(response: Response): boolean {
    const entry = this.entries.shift()
    if (!entry) return false
    entry.cleanup()
    this.emit()
    entry.resolve(response)
    return true
  }

  resolveAll(response: Response): number {
    const entries = this.entries
    if (entries.length === 0) return 0
    this.entries = []
    this.emit()
    for (const entry of entries) {
      entry.cleanup()
      entry.resolve(response)
    }
    return entries.length
  }

  subscribe(listener: InteractionListener<Request>): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot(): Request[] {
    return this.entries.map((entry) => entry.request)
  }

  private emit(): void {
    const pending = this.snapshot()
    for (const listener of this.listeners) listener(pending)
  }

  private resolveEntry(entry: InteractionEntry<Request, Response>, response: Response): boolean {
    const index = this.entries.indexOf(entry)
    if (index < 0) return false
    this.entries.splice(index, 1)
    entry.cleanup()
    this.emit()
    entry.resolve(response)
    return true
  }
}
