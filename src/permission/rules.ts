import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import { Minimatch } from 'minimatch'
import type { Rule, RuleSource, ToolCallInfo } from './types.ts'
import { withFileLock } from '../runtime/file-lock.ts'
import { commandRuleValue } from './command-policy.ts'

interface RuleFileShape {
  mode?: string
  rules?: { tool: string; pattern: string; action: string }[]
}

interface PatternMatcher {
  normalized: string
  prefix?: string
  glob?: Minimatch
}

function normalizeShape(value: unknown): RuleFileShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { rules: [] }
  const shape = value as { mode?: unknown; rules?: unknown }
  return {
    mode: typeof shape.mode === 'string' ? shape.mode : undefined,
    rules: Array.isArray(shape.rules) ? (shape.rules as RuleFileShape['rules']) : [],
  }
}

const PERSISTED_SOURCE_ORDER: RuleSource[] = ['local', 'project', 'user']

export class RuleEngine {
  private rulesBySource: Record<RuleSource, Rule[]> = { session: [], local: [], project: [], user: [] }
  private sessionRules = new Map<string, Rule[]>()
  private patternMatchers = new Map<string, PatternMatcher>()
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
    this.rulesBySource = { session: [], local: [], project: [], user: [] }
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

  addSessionRule(rule: Omit<Rule, 'source'>, sessionId?: string): void {
    const key = sessionId ?? ''
    const rules = this.sessionRules.get(key) ?? []
    rules.push({ ...rule, source: 'session' })
    this.sessionRules.set(key, rules)
  }

  clearSessionRules(sessionId?: string): void {
    if (sessionId === undefined) {
      this.sessionRules.clear()
      return
    }
    this.sessionRules.delete(sessionId)
  }

  appendProjectRule(rule: Omit<Rule, 'source'>): void {
    const file = this.projectFile
    if (!file) throw new Error('未配置项目权限规则文件')
    mkdirSync(dirname(file), { recursive: true })
    withFileLock(`${file}.lock`, () => {
      let shape: RuleFileShape = { rules: [] }
      if (existsSync(file)) {
        try {
          shape = normalizeShape(parse(readFileSync(file, 'utf8')))
        } catch {
          shape = { rules: [] }
        }
      }
      const persisted = { tool: rule.tool, pattern: rule.pattern, action: rule.action }
      if (!(shape.rules ?? []).some((current) => current.tool === persisted.tool && current.pattern === persisted.pattern && current.action === persisted.action)) {
        shape.rules = [...(shape.rules ?? []), persisted]
      }
      const content = stringify(shape)
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
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
      this.rulesBySource.project = []
      for (const current of shape.rules ?? []) {
        if (current && typeof current.tool === 'string' && typeof current.pattern === 'string' && (current.action === 'allow' || current.action === 'deny')) {
          this.rulesBySource.project.push({ tool: current.tool, pattern: current.pattern, action: current.action, source: 'project' })
        }
      }
    })
  }

  match(call: ToolCallInfo, sessionId?: string): Rule | null {
    const value = call.name === 'run_command' ? commandRuleValue(call.args) : call.args.path ?? call.args.pattern
    if (typeof value !== 'string') return null
    const normalizedInput = call.name === 'run_command' ? value.replace(/\s+/g, ' ').trim() : value
    const normalizedValue = normalizedInput.startsWith('argv:') ? normalizedInput : normalizedInput.replaceAll('\\', '/')
    const layers = [this.sessionRules.get(sessionId ?? '') ?? [], ...PERSISTED_SOURCE_ORDER.map((source) => this.rulesBySource[source])]
    for (const layer of layers) {
      // deny 优先于 allow（同层）
      for (const r of layer) {
        if (r.tool === call.name && r.action === 'deny' && this.matches(r.pattern, normalizedValue)) return r
      }
      for (const r of layer) {
        if (r.tool === call.name && r.action === 'allow' && this.matches(r.pattern, normalizedValue)) return r
      }
    }
    return null
  }

  private matches(pattern: string, normalizedValue: string): boolean {
    let cached = this.patternMatchers.get(pattern)
    if (!cached) {
      const normalized = pattern.startsWith('argv:') ? pattern : pattern.replaceAll('\\', '/')
      cached = normalized.endsWith('*') && !normalized.endsWith('**')
        ? { normalized, prefix: normalized.slice(0, -1) }
        : { normalized, glob: new Minimatch(normalized) }
      this.patternMatchers.set(pattern, cached)
    }
    if (normalizedValue === cached.normalized) return true
    if (cached.prefix !== undefined) return normalizedValue.startsWith(cached.prefix)
    return cached.glob!.match(normalizedValue)
  }

  getUserMode(): string | null {
    return this.userMode
  }
}
