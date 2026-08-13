import type { CommandDef } from './types.ts'

export class CommandRegistry {
  private byName = new Map<string, CommandDef>()
  private byAlias = new Map<string, string>()

  register(cmd: CommandDef): void {
    const names = [cmd.name, ...(cmd.aliases ?? [])]
    for (const n of names) {
      const key = n.toLowerCase()
      if (this.byName.has(key) || this.byAlias.has(key)) {
        throw new Error(`命令冲突: 「${n}」已被「${this.byAlias.get(key) ?? this.byName.get(key)?.name ?? '?'}」占用`)
      }
    }
    this.byName.set(cmd.name, cmd)
    for (const a of cmd.aliases ?? []) {
      this.byAlias.set(a.toLowerCase(), cmd.name)
    }
  }

  find(name: string): CommandDef | undefined {
    const key = name.toLowerCase()
    const canonical = this.byAlias.get(key)
    return this.byName.get(canonical ?? key)
  }

  list(includeHidden = false): CommandDef[] {
    return [...this.byName.values()].filter((c) => includeHidden || !c.hidden)
  }

  // Tab 补全：前缀匹配，hidden 排除（prefix 可带 / 前缀）
  complete(prefix: string): string[] {
    const p = (prefix.startsWith('/') ? prefix.slice(1) : prefix).toLowerCase()
    const all = new Set<string>()
    for (const cmd of this.list(false)) {
      if (cmd.name.startsWith(p)) all.add(cmd.name)
      for (const a of cmd.aliases ?? []) {
        if (a.startsWith(p)) all.add(a)
      }
    }
    return [...all].sort()
  }
}
