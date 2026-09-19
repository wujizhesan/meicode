export interface StreamBuffer {
  appendText(value: string): void
  appendThinking(value: string): void
  flush(): void
  dispose(): void
}

export function streamFlushDelay(messageCount: number): number {
  if (messageCount >= 200) return 32
  if (messageCount >= 50) return 24
  return 16
}

export function createStreamBuffer(
  onFlush: (chunk: { text: string; thinking: string }) => void,
  delayMs = 16,
): StreamBuffer {
  let text = ''
  let thinking = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!text && !thinking) return
    const chunk = { text, thinking }
    text = ''
    thinking = ''
    onFlush(chunk)
  }

  const schedule = (): void => {
    if (!timer) timer = setTimeout(flush, delayMs)
  }

  return {
    appendText(value) {
      text += value
      schedule()
    },
    appendThinking(value) {
      thinking += value
      schedule()
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
      text = ''
      thinking = ''
    },
  }
}
