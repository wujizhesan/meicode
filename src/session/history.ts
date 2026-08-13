import type { ChatMessage } from '../provider/types.ts'

export class History {
  private items: ChatMessage[] = []

  push(msg: ChatMessage): void {
    this.items.push(msg)
  }

  all(): ChatMessage[] {
    return this.items.map((m) => ({ ...m }))
  }

  clear(): void {
    this.items = []
  }

  replaceRange(start: number, end: number, messages: ChatMessage[]): void {
    this.items.splice(start, end - start, ...messages)
  }

  get length(): number {
    return this.items.length
  }
}
