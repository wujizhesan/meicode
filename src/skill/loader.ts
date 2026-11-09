import { closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../frontmatter.ts'
import type { SkillDef, SkillSource } from './types.ts'

interface Frontmatter {
  name?: unknown
  description?: unknown
  tools?: unknown
  mode?: unknown
  history?: unknown
  model?: unknown
}

interface CachedSkillDef {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  def: SkillDef | null
}

const skillDefCache = new Map<string, CachedSkillDef>()

function cloneSkillDef(def: SkillDef): SkillDef {
  return { ...def, tools: def.tools ? [...def.tools] : undefined }
}

function loadCachedSkillDef(file: string, source: SkillSource): SkillDef | null {
  const key = `${source}:${file}`
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const stats = fstatSync(fd)
    const cached = skillDefCache.get(key)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
      return cached.def ? cloneSkillDef(cached.def) : null
    }
    const def = parseSkillContent(readFileSync(fd, 'utf8'), file, source)
    skillDefCache.set(key, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, def })
    return def ? cloneSkillDef(def) : null
  } finally {
    closeSync(fd)
  }
}

export function parseSkillFile(file: string, source: SkillSource): SkillDef | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return parseSkillContent(raw, file, source)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseSkillContent(raw: string, file: string, source: SkillSource): SkillDef | null {
  // frontmatter：---\n...\n---
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) {
    console.warn(`[Skill] 缺少 frontmatter，跳过: ${file}`)
    return null
  }
  let fm: Frontmatter
  try {
    fm = parseFrontmatter<Frontmatter>(m[1])
  } catch (e) {
    console.warn(`[Skill] frontmatter 解析失败，跳过: ${file}（${(e as Error).message}）`)
    return null
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    console.warn(`[Skill] frontmatter 必须是字段对象，跳过: ${file}`)
    return null
  }
  if (!isNonEmptyString(fm.name) || !isNonEmptyString(fm.description)) {
    console.warn(`[Skill] name/description 必须是非空字符串，跳过: ${file}`)
    return null
  }
  if (fm.tools !== undefined && (!Array.isArray(fm.tools) || !fm.tools.every(isNonEmptyString))) {
    console.warn(`[Skill] tools 必须是字符串数组，且工具名不能为空，跳过: ${file}`)
    return null
  }
  if (fm.mode !== undefined && fm.mode !== 'shared' && fm.mode !== 'isolated') {
    console.warn(`[Skill] mode 必须是 shared 或 isolated，跳过: ${file}`)
    return null
  }
  if (fm.history !== undefined && (typeof fm.history !== 'number' || !Number.isSafeInteger(fm.history) || fm.history < 0)) {
    console.warn(`[Skill] history 必须是非负安全整数，跳过: ${file}`)
    return null
  }
  if (fm.model !== undefined && !isNonEmptyString(fm.model)) {
    console.warn(`[Skill] model 必须是非空字符串，跳过: ${file}`)
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
  const out: SkillDef[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(full).isDirectory()
      } catch {
        continue
      }
    }
    if (isDirectory) {
      const entryMd = join(full, 'SKILL.md')
      const def = loadCachedSkillDef(entryMd, source)
      if (def) out.push(def)
    } else if (entry.name.endsWith('.md')) {
      const def = loadCachedSkillDef(full, source)
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
