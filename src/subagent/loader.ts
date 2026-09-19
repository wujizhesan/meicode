import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../frontmatter.ts'
import type { AgentRole, AgentRoleSource } from './types.ts'

interface Frontmatter {
  name?: string
  description?: string
  tools_allow?: string[]
  tools_deny?: string[]
  write_paths?: string[]
  model?: string
  max_rounds?: number
  permission?: string
}

interface CachedAgentRole {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  role: AgentRole | null
}

const agentRoleCache = new Map<string, CachedAgentRole>()

function cloneAgentRole(role: AgentRole): AgentRole {
  return {
    ...role,
    toolsAllow: role.toolsAllow ? [...role.toolsAllow] : undefined,
    toolsDeny: role.toolsDeny ? [...role.toolsDeny] : undefined,
    writePaths: role.writePaths ? [...role.writePaths] : undefined,
  }
}

function loadCachedAgentRole(file: string, source: AgentRoleSource): AgentRole | null {
  const key = `${source}:${file}`
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const stats = fstatSync(fd)
    const cached = agentRoleCache.get(key)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
      return cached.role ? cloneAgentRole(cached.role) : null
    }
    const role = parseAgentContent(readFileSync(fd, 'utf8'), file, source)
    agentRoleCache.set(key, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, role })
    return role ? cloneAgentRole(role) : null
  } finally {
    closeSync(fd)
  }
}

export function parseAgentFile(file: string, source: AgentRoleSource): AgentRole | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return parseAgentContent(raw, file, source)
}

function parseAgentContent(raw: string, file: string, source: AgentRoleSource): AgentRole | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) {
    console.warn(`[子Agent] 缺少 frontmatter，跳过: ${file}`)
    return null
  }
  let fm: Frontmatter
  try {
    fm = parseFrontmatter<Frontmatter>(m[1])
  } catch (e) {
    console.warn(`[子Agent] frontmatter 解析失败，跳过: ${file}（${(e as Error).message}）`)
    return null
  }
  if (!fm.name || !fm.description) {
    console.warn(`[子Agent] 缺 name/description，跳过: ${file}`)
    return null
  }
  const permission = fm.permission === 'strict' || fm.permission === 'permissive' ? fm.permission : 'default'
  return {
    name: fm.name,
    description: fm.description,
    toolsAllow: fm.tools_allow,
    writePaths: fm.write_paths,
    toolsDeny: fm.tools_deny,
    model: fm.model,
    maxRounds: fm.max_rounds,
    permission,
    content: (m[2] ?? '').trim(),
    source,
  }
}

function scanAgentsDir(dir: string, source: AgentRoleSource): AgentRole[] {
  const out: AgentRole[] = []
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
      const entryMd = join(full, 'AGENT.md')
      const role = loadCachedAgentRole(entryMd, source)
      if (role) out.push(role)
    } else if (entry.name.endsWith('.md')) {
      const role = loadCachedAgentRole(full, source)
      if (role) out.push(role)
    }
  }
  return out
}

// 四来源（项目 > 用户 > 内置；plugin 层本阶段无）同名覆盖
export function loadAgentRoles(dirs: { builtin: string; user: string; project: string }): AgentRole[] {
  const merged = new Map<string, AgentRole>()
  for (const [dir, source] of [
    [dirs.builtin, 'builtin'],
    [dirs.user, 'user'],
    [dirs.project, 'project'],
  ] as const) {
    for (const role of scanAgentsDir(dir, source)) {
      merged.set(role.name, role)
    }
  }
  return [...merged.values()]
}

export function agentDirs(cwd: string): { builtin: string; user: string; project: string } {
  const packaged = join(import.meta.dirname, 'agents')
  const source = join(import.meta.dirname, '..', 'agents')
  return {
    builtin: existsSync(packaged) ? packaged : source,
    user: join(homedir(), '.mewcode', 'agents'),
    project: join(cwd, 'agents'),
  }
}
