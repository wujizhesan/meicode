import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { SkillDef, SkillSource } from './types.ts'

interface Frontmatter {
  name?: string
  description?: string
  tools?: string[]
  mode?: string
  history?: number
  model?: string
}

export function parseSkillFile(file: string, source: SkillSource): SkillDef | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // frontmatter：---\n...\n---
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) {
    console.warn(`[Skill] 缺少 frontmatter，跳过: ${file}`)
    return null
  }
  let fm: Frontmatter
  try {
    fm = (parse(m[1]) ?? {}) as Frontmatter
  } catch (e) {
    console.warn(`[Skill] frontmatter 解析失败，跳过: ${file}（${(e as Error).message}）`)
    return null
  }
  if (!fm.name || !fm.description) {
    console.warn(`[Skill] 缺 name/description，跳过: ${file}`)
    return null
  }
  return {
    name: fm.name,
    description: fm.description,
    tools: fm.tools,
    mode: fm.mode === 'isolated' ? 'isolated' : 'shared',
    history: fm.history,
    model: fm.model,
    content: (m[2] ?? '').trim(),
    source,
  }
}

// 扫描一个目录：文件型 *.md + 目录型 <name>/SKILL.md
export function scanDir(dir: string, source: SkillSource): SkillDef[] {
  if (!existsSync(dir)) return []
  const out: SkillDef[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const entryMd = join(full, 'SKILL.md')
      if (existsSync(entryMd)) {
        const def = parseSkillFile(entryMd, source)
        if (def) out.push(def)
      }
    } else if (entry.endsWith('.md')) {
      const def = parseSkillFile(full, source)
      if (def) out.push(def)
    }
  }
  return out
}

// 三级加载：内置 → 用户 → 项目（后加载覆盖同名）
export function loadAllSkills(dirs: { builtin: string; user: string; project: string }): {
  skills: SkillDef[]
  skipped: string[]
} {
  const merged = new Map<string, SkillDef>()
  for (const [dir, source] of [
    [dirs.builtin, 'builtin'],
    [dirs.user, 'user'],
    [dirs.project, 'project'],
  ] as const) {
    for (const def of scanDir(dir, source)) {
      merged.set(def.name, def) // 同名覆盖（后加载高优先级）
    }
  }
  return { skills: [...merged.values()], skipped: [] }
}
