import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
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

export function parseAgentFile(file: string, source: AgentRoleSource): AgentRole | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) {
    console.warn(`[子Agent] 缺少 frontmatter，跳过: ${file}`)
    return null
  }
  let fm: Frontmatter
  try {
    fm = (parse(m[1]) ?? {}) as Frontmatter
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
  if (!existsSync(dir)) return []
  const out: AgentRole[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const entryMd = join(full, 'AGENT.md')
      if (existsSync(entryMd)) {
        const role = parseAgentFile(entryMd, source)
        if (role) out.push(role)
      }
    } else if (entry.endsWith('.md')) {
      const role = parseAgentFile(full, source)
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
