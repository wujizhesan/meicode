import { loadAllSkills } from './loader.ts'
import type { ActiveSkill, SkillDef, SkillDirs } from './types.ts'

const SYSTEM_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'grep_code', 'load_skill'])

export class SkillManager {
  private all = new Map<string, SkillDef>()
  private active = new Map<string, ActiveSkill>()
  private pendingIsolated = new Set<string>()
  private dirs: SkillDirs
  private onActivate: ((name: string, def: SkillDef) => void) | null = null

  constructor(dirs: SkillDirs) {
    this.dirs = dirs
  }

  setOnActivate(cb: (name: string, def: SkillDef) => void): void {
    this.onActivate = cb
  }

  loadAll(): { ok: string[]; unavailable: string[] } {
    const { skills } = loadAllSkills(this.dirs)
    this.all.clear()
    const ok: string[] = []
    const unavailable: string[] = []
    for (const def of skills) {
      // 白名单校验：未知工具 → 警告 + 标记不可用
      const badTools = (def.tools ?? []).filter((t) => !SYSTEM_TOOLS.has(t))
      if (badTools.length > 0) {
        console.warn(`[Skill] ${def.name} 白名单含未知工具（${badTools.join(', ')}），该 Skill 不可用`)
        unavailable.push(def.name)
        continue
      }
      this.all.set(def.name, def)
      ok.push(def.name)
    }
    return { ok, unavailable }
  }

  index(): string {
    const lines = [...this.all.values()].map((s) => `- ${s.name}: ${s.description}`)
    return lines.length > 0 ? `## 可用 Skills\n${lines.join('\n')}` : ''
  }

  get(name: string): SkillDef | undefined {
    return this.all.get(name)
  }

  list(): SkillDef[] {
    return [...this.all.values()]
  }

  createScope(): SkillManager {
    const scope = new SkillManager({ ...this.dirs })
    for (const [name, def] of this.all) scope.all.set(name, structuredClone(def))
    return scope
  }

  activate(name: string, params: Record<string, string> = {}): string {
    const def = this.all.get(name)
    if (!def) return `未找到 Skill: ${name}（/help 或查看可用 Skills 列表）`
    this.active.set(name, { def, params })
    if (def.mode === 'isolated') this.pendingIsolated.add(name)
    else this.pendingIsolated.delete(name)
    this.lastActivated = { name, mode: def.mode }
    this.onActivate?.(name, def)
    return `已激活 Skill: ${name}（${def.mode} 模式）`
  }

  deactivate(name: string): void {
    this.active.delete(name)
    this.pendingIsolated.delete(name)
    if (this.lastActivated?.name === name) this.lastActivated = null
  }

  clear(): void {
    this.active.clear()
    this.clearPendingIsolated()
  }

  clearPendingIsolated(): void {
    this.pendingIsolated.clear()
    this.lastActivated = null
  }

  takeNextIsolated(): SkillDef | undefined {
    for (const name of this.pendingIsolated) {
      this.pendingIsolated.delete(name)
      const active = this.active.get(name)
      const def = this.all.get(name)
      if (!active || def?.mode !== 'isolated') continue
      let content = def.content
      for (const [key, value] of Object.entries(active.params)) content = content.replaceAll(`{{${key}}}`, value)
      return { ...def, tools: def.tools ? [...def.tools] : undefined, content }
    }
    return undefined
  }

  isActive(name: string): boolean {
    return this.active.has(name)
  }

  activePrompt(): string {
    const parts: string[] = []
    for (const { def, params } of this.active.values()) {
      if (def.mode !== 'shared') continue
      let content = def.content
      for (const [k, v] of Object.entries(params)) {
        content = content.replaceAll(`{{${k}}}`, v)
      }
      parts.push(`## 已激活 Skill: ${def.name}\n\n${content}`)
    }
    return parts.join('\n\n')
  }

  activeToolNames(): string[] | null {
    if (this.active.size === 0) return null
    const set = new Set<string>()
    let constrained = false
    for (const { def } of this.active.values()) {
      if (def.mode !== 'shared' || def.tools === undefined) continue
      constrained = true
      for (const t of def.tools) set.add(t)
    }
    return constrained ? [...set] : null
  }

  lastActivated: { name: string; mode: 'shared' | 'isolated' } | null = null
}
