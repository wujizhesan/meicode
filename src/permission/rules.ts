import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import { minimatch } from 'minimatch'
import type { Rule, RuleSource, ToolCallInfo } from './types.ts'

interface RuleFileShape {
  mode?: string
  rules?: { tool: string; pattern: string; action: string }[]
}

function normalizeShape(value: unknown): RuleFileShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { rules: [] }
  const shape = value as { mode?: unknown; rules?: unknown }
  return {
    mode: typeof shape.mode === 'string' ? shape.mode : undefined,
    rules: Array.isArray(shape.rules) ? (shape.rules as RuleFileShape['rules']) : [],
  }
}

const SOURCE_ORDER: RuleSource[] = ['session', 'local', 'project', 'user']

export class RuleEngine {
  private rulesBySource: Record<RuleSource, Rule[]> = { session: [], local: [], project: [], user: [] }
  private userMode: string | null = null
  private userFile: string
  private projectFile: string
  private localFile: string

  constructor(userFile: string, projectFile: string, localFile: string) {
    this.userFile = userFile
    this.projectFile = projectFile
    this.localFile = localFile
  }

  loadAll(): void {
    const sessionRules = this.rulesBySource.session
    this.rulesBySource = { session: sessionRules, local: [], project: [], user: [] }
    this.userMode = null
    this.loadFile(this.userFile, 'user')
    this.loadFile(this.projectFile, 'project')
    this.loadFile(this.localFile, 'local')
  }

  private loadFile(file: string, source: RuleSource): void {
    if (!existsSync(file)) return
    let parsed: RuleFileShape
    try {
      parsed = normalizeShape(parse(readFileSync(file, 'utf8')))
    } catch (e) {
      console.warn(`[权限] 规则文件解析失败，已跳过: ${file}（${(e as Error).message}）`)
      return
    }
    if (source === 'user' && typeof parsed.mode === 'string') {
      this.userMode = parsed.mode
    }
    if (Array.isArray(parsed.rules)) {
      for (const r of parsed.rules) {
        if (r && typeof r.tool === 'string' && typeof r.pattern === 'string' && (r.action === 'allow' || r.action === 'deny')) {
          this.rulesBySource[source].push({ tool: r.tool, pattern: r.pattern, action: r.action, source })
        }
      }
    }
  }

  addSessionRule(rule: Omit<Rule, 'source'>): void {
    this.rulesBySource.session.push({ ...rule, source: 'session' })
  }

  appendProjectRule(rule: Omit<Rule, 'source'>): void {
    const file = this.projectFile
    let shape: RuleFileShape = { rules: [] }
    if (existsSync(file)) {
      try {
        shape = normalizeShape(parse(readFileSync(file, 'utf8')))
      } catch {
        shape = { rules: [] }
      }
    }
    shape.rules = [...(shape.rules ?? []), { tool: rule.tool, pattern: rule.pattern, action: rule.action }]
    mkdirSync(dirname(file), { recursive: true })
    const content = stringify(shape)
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, content, 'utf8')
      try {
        renameSync(temp, file)
      } catch {
        writeFileSync(file, content, 'utf8')
        rmSync(temp, { force: true })
      }
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    this.rulesBySource.project.push({ ...rule, source: 'project' })
  }

  match(call: ToolCallInfo): Rule | null {
    for (const source of SOURCE_ORDER) {
      const layer = this.rulesBySource[source]
      // deny 优先于 allow（同层）
      for (const r of layer) {
        if (r.tool === call.name && r.action === 'deny' && this.matches(r.pattern, call)) return r
      }
      for (const r of layer) {
        if (r.tool === call.name && r.action === 'allow' && this.matches(r.pattern, call)) return r
      }
    }
    return null
  }

  private matches(pattern: string, call: ToolCallInfo): boolean {
    const value = call.args.command ?? call.args.path ?? call.args.pattern
    if (typeof value !== 'string') return false
    // 命令规范化：与 patternFor 写入侧一致（空白归一）——同一缓存键可命中
    const normInput = call.name === 'run_command' ? value.replace(/\s+/g, ' ').trim() : value
    // Windows 路径反斜杠在 glob 中是转义符——统一转正斜杠
    const normValue = normInput.replaceAll('\\', '/')
    const normPattern = pattern.replaceAll('\\', '/')
    if (normValue === normPattern) return true
    // 命令类模式：'git *' 语义 = 前缀匹配（minimatch 的 * 不跨空格）
    if (normPattern.endsWith('*') && !normPattern.endsWith('**')) {
      return normValue.startsWith(normPattern.slice(0, -1))
    }
    return minimatch(normValue, normPattern)
  }

  getUserMode(): string | null {
    return this.userMode
  }
}
