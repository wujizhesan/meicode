export type CloseTaskOutcome = 'closed' | 'failed' | 'timed_out'

export const DEFAULT_CLOSE_TIMEOUT_MS = 5000

export function settleCloseTask(
  label: string,
  task: () => void | Promise<void>,
  timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  warn: (message: string) => void = console.warn,
): Promise<CloseTaskOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: CloseTaskOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      warn(`[退出] ${label} 关闭超时（${timeoutMs}ms）`)
      finish('timed_out')
    }, Math.max(1, timeoutMs))
    Promise.resolve()
      .then(task)
      .then(
        () => finish('closed'),
        (error) => {
          warn(`[退出] ${label} 关闭失败：${error instanceof Error ? error.message : String(error)}`)
          finish('failed')
        },
      )
  })
}
