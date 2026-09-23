export function resolveOnAbort<T>(source: Promise<T> | (() => Promise<T>), signal: AbortSignal | undefined, fallback: T): Promise<T> {
  const start = (): Promise<T> => typeof source === 'function' ? source() : source
  if (!signal) return start()
  if (signal.aborted) return Promise.resolve(fallback)
  let promise: Promise<T>
  try {
    promise = start()
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (handler: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      handler()
    }
    const onAbort = (): void => finish(() => resolve(fallback))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}
