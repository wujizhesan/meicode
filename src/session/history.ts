import type { ChatMessage } from '../provider/types.ts'

export class History {
  private items: ChatMessage[] = []
  private revision = 0
  private structureRevision = 0

  push(msg: ChatMessage): void {
    this.items.push(msg)
    this.revision++
  }

  all(): ChatMessage[] {
    return this.items.map((m) => ({ ...m }))
  }

  view(): readonly ChatMessage[] {
    return this.items
  }

  clear(): void {
    this.items = []
    this.revision++
    this.structureRevision++
  }

  replaceRange(start: number, end: number, messages: ChatMessage[]): void {
    this.items.splice(start, end - start, ...messages)
    this.revision++
    this.structureRevision++
  }

  get length(): number {
    return this.items.length
  }

  get version(): number {
    return this.revision
  }

  get structureVersion(): number {
    return this.structureRevision
  }
}
