export const READ_ONLY_TOOLS = new Set(['read_file', 'find_files', 'grep_code'])

const REPEAT_EXEMPT_TOOLS = new Set([...READ_ONLY_TOOLS, 'team_tasks', 'team_mail'])

export interface LoopToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface RepeatedToolCall {
  name: string
  count: number
}

export function nextUnknownToolStreak(
  calls: readonly LoopToolCall[],
  isKnown: (name: string) => boolean,
  current: number,
): number {
  return calls.every((call) => !isKnown(call.name)) ? current + 1 : 0
}

export function nextToolFailureStreak(successes: readonly boolean[], current: number): number {
  return successes.length > 0 && successes.every((success) => !success) ? current + 1 : 0
}

export class RepeatedToolCallGuard {
  private readonly recent: string[] = []
  private readonly window: number
  private readonly threshold: number

  constructor(window = 6, threshold = 5) {
    this.window = window
    this.threshold = threshold
  }

  inspect<T extends LoopToolCall>(
    calls: readonly T[],
    isKnown: (name: string) => boolean,
    serialize: (call: T) => string,
  ): RepeatedToolCall | null {
    for (const call of calls) {
      if (!isKnown(call.name) || REPEAT_EXEMPT_TOOLS.has(call.name)) continue
      const signature = `${call.name}:${serialize(call).slice(0, 100)}`
      this.recent.push(signature)
      if (this.recent.length > this.window) this.recent.shift()
      const count = this.recent.filter((item) => item === signature).length
      if (count >= this.threshold) return { name: call.name, count }
    }
    return null
  }
}
