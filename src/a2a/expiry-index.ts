interface ExpiryEntry {
  id: string
  at: number
}

export class A2aExpiryIndex {
  private readonly entries: ExpiryEntry[] = []
  private readonly positions = new Map<string, number>()

  peek(): ExpiryEntry | undefined {
    return this.entries[0]
  }

  pop(): ExpiryEntry | undefined {
    const entry = this.entries[0]
    if (entry) this.delete(entry.id)
    return entry
  }

  set(id: string, at: number | undefined): void {
    if (at === undefined || !Number.isFinite(at)) {
      this.delete(id)
      return
    }
    const index = this.positions.get(id)
    if (index === undefined) {
      const next = this.entries.push({ id, at }) - 1
      this.positions.set(id, next)
      this.moveUp(next)
      return
    }
    const previous = this.entries[index].at
    this.entries[index].at = at
    if (at < previous) this.moveUp(index)
    else if (at > previous) this.moveDown(index)
  }

  delete(id: string): void {
    const index = this.positions.get(id)
    if (index === undefined) return
    const last = this.entries.pop()!
    this.positions.delete(id)
    if (index === this.entries.length) return
    this.entries[index] = last
    this.positions.set(last.id, index)
    const parent = (index - 1) >>> 1
    if (index > 0 && this.less(index, parent)) this.moveUp(index)
    else this.moveDown(index)
  }

  private less(left: number, right: number): boolean {
    return this.entries[left].at < this.entries[right].at
  }

  private swap(left: number, right: number): void {
    const a = this.entries[left]
    const b = this.entries[right]
    this.entries[left] = b
    this.entries[right] = a
    this.positions.set(a.id, right)
    this.positions.set(b.id, left)
  }

  private moveUp(start: number): void {
    let index = start
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (!this.less(index, parent)) break
      this.swap(index, parent)
      index = parent
    }
  }

  private moveDown(start: number): void {
    let index = start
    while (true) {
      const left = index * 2 + 1
      if (left >= this.entries.length) break
      const right = left + 1
      const next = right < this.entries.length && this.less(right, left) ? right : left
      if (!this.less(next, index)) break
      this.swap(index, next)
      index = next
    }
  }
}
