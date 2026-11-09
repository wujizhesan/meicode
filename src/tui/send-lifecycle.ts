export interface StreamingLifecycleOptions {
  isRunning(): boolean
  start(): void
  fail(error: unknown): void
  finish(): void | Promise<void>
}

export async function runStreamingLifecycle(
  options: StreamingLifecycleOptions,
  task: () => Promise<void>,
): Promise<void> {
  if (options.isRunning()) return
  try {
    options.start()
    await task()
  } catch (error) {
    options.fail(error)
  } finally {
    await options.finish()
  }
}

export function streamingFailureMessage(error: unknown): string {
  return `执行失败：${error instanceof Error ? error.message : String(error)}`
}
