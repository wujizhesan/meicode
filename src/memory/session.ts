import { appendFileSync, closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { ChatMessage } from '../provider/types.ts'
import { assertChatMessages, isChatMessage } from '../provider/message.ts'
import { withFileLock } from '../runtime/file-lock.ts'
import { writeTextAtomicSync } from '../tools/atomic-write.ts'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const RECEIPT_PREFIX = Buffer.from('{"type":"subagent_report_receipts",')

export interface SubAgentTaskSource {
  sessionId: string
  agentId: string
}

interface SessionReports {
  ids: Set<string>
  tasks: SubAgentTaskSource[]
}

function mergeTaskSources(...groups: (readonly SubAgentTaskSource[])[]): SubAgentTaskSource[] {
  const sources = new Map<string, SubAgentTaskSource>()
  for (const group of groups) for (const source of group) {
    sources.set(JSON.stringify([source.sessionId, source.agentId]), { ...source })
  }
  return [...sources.values()]
}

function receiptIds(value: unknown): string[] | null {
  if (!value || typeof value !== 'object') return null
  const row = value as { type?: unknown; ids?: unknown }
  return row.type === 'subagent_report_receipts' && Array.isArray(row.ids)
    && row.ids.every((id): id is string => typeof id === 'string' && id.length > 0) ? row.ids : null
}

export function subAgentReportId(message: ChatMessage): string | undefined {
  return message.role === 'system' ? /^\[子任务报告 ([^\]\r\n]+)\]\n/.exec(message.content)?.[1] : undefined
}

function readReceipts(raw: string): SessionReports {
  const ids = new Set<string>()
  const tasks: SubAgentTaskSource[] = []
  for (const line of raw.split('\n')) {
    try {
      const value: unknown = JSON.parse(line)
      const recorded = receiptIds(value)
      if (recorded) {
        for (const id of recorded) ids.add(id)
        const sources = (value as { tasks?: unknown }).tasks
        if (Array.isArray(sources)) for (const source of sources) {
          if (source && typeof source.sessionId === 'string' && SESSION_ID_RE.test(source.sessionId)
            && typeof source.agentId === 'string' && SESSION_ID_RE.test(source.agentId)) {
            tasks.push({ sessionId: source.sessionId, agentId: source.agentId })
          }
        }
      } else if (isChatMessage(value)) {
        const id = subAgentReportId(value)
        if (id) ids.add(id)
      }
    } catch {}
  }
  return { ids, tasks: mergeTaskSources(tasks) }
}

function receiptLine(ids: Iterable<string>, tasks: readonly SubAgentTaskSource[] = []): string {
  const list = [...ids]
  return list.length || tasks.length
    ? `${JSON.stringify({ type: 'subagent_report_receipts', ids: list, ...(tasks.length ? { tasks } : {}) })}\n` : ''
}

export class SessionConflictError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`会话 ${sessionId} 已被其他进程更新，请先重新加载`)
    this.name = 'SessionConflictError'
    this.sessionId = sessionId
  }
}

interface SessionFileMetadata {
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface SessionCountSnapshot extends SessionFileMetadata {
  count: number
}

interface SessionFileInfo {
  file: string
  stats: SessionFileMetadata | null
}

function matchesSnapshot(snapshot: SessionCountSnapshot, stats: SessionFileMetadata): boolean {
  return snapshot.size === stats.size && snapshot.mtimeMs === stats.mtimeMs && snapshot.ctimeMs === stats.ctimeMs
}

function sameMetadata(left: SessionFileMetadata | null, right: SessionFileMetadata | null): boolean {
  if (!left || !right) return left === right
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function countNonEmptyLines(content: Buffer): number {
  let count = 0
  let hasContent = false
  let start = 0
  const countLine = (end: number): void => {
    if (!hasContent) return
    const line = content.subarray(start, end)
    if (line.subarray(0, RECEIPT_PREFIX.length).equals(RECEIPT_PREFIX)) {
      try { if (receiptIds(JSON.parse(line.toString('utf8')))) return } catch {}
    }
    count++
  }
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === 10) {
      countLine(i)
      hasContent = false
      start = i + 1
    } else if (char !== 13 && char !== 32 && char !== 9) {
      hasContent = true
    }
  }
  countLine(content.length)
  return count
}

// 防御校验：assistant(tool_calls) 后面必须紧跟配对的 tool 消息（否则 DeepSeek/OpenAI 400）
// 两重检查：① 每个 tool_call id 有配对 tool；② 紧邻性——配对完成前不允许插入任何其他消息
// （插 system/user/新 assistant 都违反紧邻；缺失/交错 → 连带删除该 assistant 及其已入队 tool）
export function sanitizeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pendingIdx = -1 // 欠 tool 的 assistant 在 out 中的位置（-1 = 无欠债）
  const pendingIds = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      // 新 assistant(tool_calls)：若前面还有欠债，弹回（交错序列不允许）
      if (pendingIdx >= 0) {
        out.splice(pendingIdx)
        pendingIdx = -1
        pendingIds.clear()
      }
      if (new Set(m.tool_calls.map((call) => call.id)).size !== m.tool_calls.length) continue
      out.push(m)
      pendingIdx = out.length - 1
      for (const t of m.tool_calls) pendingIds.add(t.id)
    } else if (m.role === 'tool') {
      if (m.tool_call_id && pendingIds.has(m.tool_call_id)) {
        out.push(m)
        pendingIds.delete(m.tool_call_id)
        if (pendingIds.size === 0) pendingIdx = -1
      }
      // 孤儿 tool（无前置 assistant 或 id 不匹配）→ 删除
    } else {
      // 非 tool 消息：若还有欠债 assistant → 紧邻性被破坏，弹回
      if (pendingIdx >= 0) {
        out.splice(pendingIdx)
        pendingIdx = -1
        pendingIds.clear()
      }
      out.push(m)
    }
  }
  // 尾部欠债：assistant(tool_calls) 未获全部结果 → 弹回
  if (pendingIdx >= 0) out.splice(pendingIdx)
  return out
}

export function newSessionId(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ts}-${rand}`
}

export class SessionStore {
  private dir: string
  private countCache = new Map<string, SessionCountSnapshot>()
  private writeSnapshots = new Map<string, SessionFileMetadata | null>()
  private receiptCache = new Map<string, { stats: SessionFileMetadata; reports: SessionReports }>()
  private receiptSnapshots = new Map<string, SessionReports>()
  private dirReady = false

  constructor(dir: string) {
    this.dir = dir
  }

  private ensureDir(): void {
    if (this.dirReady) return
    mkdirSync(this.dir, { recursive: true })
    this.dirReady = true
  }

  private fileInfoFor(id: string): SessionFileInfo | null {
    if (!SESSION_ID_RE.test(id)) return null
    const root = resolve(this.dir)
    const file = resolve(join(root, `${id}.jsonl`))
    if (file !== root && !file.startsWith(root + sep)) return null
    try {
      const stats = lstatSync(file)
      if (stats.isSymbolicLink()) return null
      return { file, stats }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    return { file, stats: null }
  }

  private fileFor(id: string): string | null {
    return this.fileInfoFor(id)?.file ?? null
  }

  private loadReceipts(file: string, stats: SessionFileMetadata | null): SessionReports {
    if (!stats) return { ids: new Set(), tasks: [] }
    const cached = this.receiptCache.get(file)
    if (cached && sameMetadata(cached.stats, stats)) return cached.reports
    const reports = readReceipts(readFileSync(file, 'utf8'))
    this.receiptCache.set(file, { stats, reports })
    return reports
  }

  hasReportReceipt(id: string, report: string): boolean {
    const info = this.fileInfoFor(id)
    return info ? this.loadReceipts(info.file, info.stats).ids.has(report) : false
  }

  getSubAgentTaskSources(id: string): SubAgentTaskSource[] {
    const info = this.fileInfoFor(id)
    return info ? this.loadReceipts(info.file, info.stats).tasks.map((source) => ({ ...source })) : []
  }

  private rememberReceipts(file: string, stats: SessionFileMetadata, reports: SessionReports): void {
    this.receiptCache.set(file, { stats, reports: { ids: new Set(reports.ids), tasks: mergeTaskSources(reports.tasks) } })
    this.receiptSnapshots.set(file, { ids: new Set(reports.ids), tasks: mergeTaskSources(reports.tasks) })
  }

  append(id: string, messages: ChatMessage[], inheritedReceipts: readonly string[] = []): void {
    if (messages.length === 0 && inheritedReceipts.length === 0) return
    assertChatMessages(messages)
    const info = this.fileInfoFor(id)
    if (!info) throw new Error('非法会话 ID')
    const { file } = info
    const content = messages.length ? messages.map((message) => JSON.stringify(message)).join('\n') + '\n' : ''
    this.ensureDir()
    withFileLock(`${file}.lock`, () => {
      const current = this.fileInfoFor(id)
      if (!current) throw new Error('非法会话 ID')
      const before = current.stats
      if (this.writeSnapshots.has(file) && !sameMetadata(this.writeSnapshots.get(file) ?? null, before)) {
        throw new SessionConflictError(id)
      }
      const cached = this.countCache.get(file)
      const reports = this.loadReceipts(file, before)
      const ids = new Set(reports.ids)
      const added = new Set<string>()
      for (const report of inheritedReceipts) {
        if (!ids.has(report)) { ids.add(report); added.add(report) }
      }
      for (const message of messages) {
        const report = subAgentReportId(message)
        if (report && !ids.has(report)) { ids.add(report); added.add(report) }
      }
      if (messages.length === 0 && added.size === 0) return
      let separator = ''
      if (before && before.size > 0) {
        const fd = openSync(file, 'r')
        try {
          const tail = Buffer.allocUnsafe(1)
          if (readSync(fd, tail, 0, 1, before.size - 1) !== 1) throw new Error('读取会话尾行失败')
          if (tail[0] !== 10) separator = '\n'
        } finally { closeSync(fd) }
      }
      appendFileSync(file, separator + content + receiptLine(added), 'utf8')
      const after = statSync(file)
      this.writeSnapshots.set(file, after)
      this.rememberReceipts(file, after, { ids, tasks: reports.tasks })
      if (!before) {
        this.countCache.set(file, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, count: messages.length })
      } else if (cached && matchesSnapshot(cached, before)) {
        this.countCache.set(file, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, count: cached.count + messages.length })
      } else {
        this.countCache.delete(file)
      }
    })
  }

  replace(id: string, messages: ChatMessage[], inheritedReceipts: readonly string[] = [], inheritedTasks: readonly SubAgentTaskSource[] = []): void {
    assertChatMessages(messages)
    const info = this.fileInfoFor(id)
    if (!info) throw new Error('非法会话 ID')
    this.ensureDir()
    withFileLock(`${info.file}.lock`, () => {
      const current = this.fileInfoFor(id)
      if (!current) throw new Error('非法会话 ID')
      if (this.writeSnapshots.has(info.file) && !sameMetadata(this.writeSnapshots.get(info.file) ?? null, current.stats)) {
        throw new SessionConflictError(id)
      }
      const reports = this.loadReceipts(info.file, current.stats)
      const ids = new Set(reports.ids)
      const tasks = mergeTaskSources(reports.tasks, inheritedTasks)
      for (const report of inheritedReceipts) ids.add(report)
      for (const message of messages) {
        const report = subAgentReportId(message)
        if (report) ids.add(report)
      }
      const content = (messages.length ? `${messages.map((message) => JSON.stringify(message)).join('\n')}\n` : '') + receiptLine(ids, tasks)
      try {
        const destination = join(realpathSync.native(dirname(info.file)), basename(info.file))
        writeTextAtomicSync(destination, content, { cwd: resolve(this.dir) })
      } catch (error) {
        this.countCache.delete(info.file)
        this.receiptCache.delete(info.file)
        throw error
      }
      const stats = statSync(info.file)
      this.writeSnapshots.set(info.file, stats)
      this.rememberReceipts(info.file, stats, { ids, tasks })
      this.countCache.set(info.file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, count: messages.length })
    })
  }

  saveConflictCopy(sourceId: string, messages: ChatMessage[], inheritedReceipts: readonly string[] = [], inheritedTasks: readonly SubAgentTaskSource[] = []): string {
    assertChatMessages(messages)
    const sourceFile = this.fileFor(sourceId)
    const reports = sourceFile ? this.receiptSnapshots.get(sourceFile) : undefined
    const inherited = [...new Set([...(reports?.ids ?? []), ...inheritedReceipts])]
    const tasks = mergeTaskSources(reports?.tasks ?? [], inheritedTasks)
    const prefix = SESSION_ID_RE.test(sourceId) ? sourceId.slice(0, 72) : 'session'
    for (let attempt = 0; attempt < 10; attempt++) {
      const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const id = `${prefix}-conflict-${suffix}`.slice(0, 128)
      const file = this.fileFor(id)
      if (!file || existsSync(file)) continue
      new SessionStore(this.dir).replace(id, messages, inherited, tasks)
      return id
    }
    throw new Error(`无法为会话 ${sourceId} 创建冲突副本`)
  }

  // 恢复：坏行跳过、工具调用无结果截断
  recoverLatest(): { id: string; messages: ChatMessage[] } | null {
    if (!existsSync(this.dir)) return null
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl') && SESSION_ID_RE.test(f.slice(0, -'.jsonl'.length)))
      .sort()
      .reverse()
    if (files.length === 0) return null
    return this.recoverById(files[0].replace(/\.jsonl$/, ''))
  }

  recoverById(id: string): { id: string; messages: ChatMessage[] } | null {
    const recovered = this.prepareRecovery(id)
    if (!recovered) return null
    recovered.commit()
    return { id: recovered.id, messages: recovered.messages }
  }

  prepareRecovery(id: string): { id: string; messages: ChatMessage[]; commit(): void } | null {
    const file = this.fileFor(id)
    if (!file) return null
    let stats: ReturnType<typeof statSync>
    let raw: string
    try {
      stats = statSync(file)
      raw = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    const messages: ChatMessage[] = []
    let needsSanitization = false
    let lineStart = 0
    while (lineStart < raw.length) {
      const newline = raw.indexOf('\n', lineStart)
      const lineEnd = newline < 0 ? raw.length : newline
      const line = raw.slice(lineStart, lineEnd)
      lineStart = lineEnd + 1
      if (!line.trim()) continue
      try {
        const message: unknown = JSON.parse(line)
        if (!isChatMessage(message)) continue
        messages.push(message)
        if (message.role === 'tool' || (message.role === 'assistant' && message.tool_calls?.length)) needsSanitization = true
      } catch {
      }
    }
    const recovered = needsSanitization ? sanitizeMessages(messages) : messages
    const reports = readReceipts(raw)
    return {
      id,
      messages: recovered,
      commit: () => {
        this.writeSnapshots.set(file, stats)
        this.rememberReceipts(file, stats, reports)
        this.countCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, count: recovered.length })
      },
    }
  }

  listSessions(limit = 5): { id: string; count: number; mtime: number }[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl') && SESSION_ID_RE.test(f.slice(0, -'.jsonl'.length)))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        const id = f.replace(/\.jsonl$/, '')
        const file = this.fileFor(id)
        if (!file) return { id, count: 0, mtime: 0 }
        try {
          const stats = statSync(file)
          const cached = this.countCache.get(file)
          const count = cached && matchesSnapshot(cached, stats) ? cached.count : countNonEmptyLines(readFileSync(file))
          if (!cached || !matchesSnapshot(cached, stats)) {
            this.countCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, count })
          }
          return { id, count, mtime: stats.mtimeMs }
        } catch {
          return { id, count: 0, mtime: 0 }
        }
      })
  }

  // 删除单个会话（当前会话由调用方防护）
  removeById(id: string): boolean {
    const file = this.fileFor(id)
    if (!file) return false
    let removed = false
    withFileLock(`${file}.lock`, () => {
      if (!existsSync(file)) return
      rmSync(file, { force: true })
      this.countCache.delete(file)
      this.writeSnapshots.delete(file)
      this.receiptCache.delete(file)
      this.receiptSnapshots.delete(file)
      removed = true
    })
    return removed
  }

  // 距上次活动 >24h 的提醒消息
  timeGapMessage(id: string): ChatMessage | null {
    const file = this.fileFor(id)
    if (!file) return null
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      return null
    }
    const gap = Date.now() - mtime
    if (gap <= 24 * HOUR) return null
    const days = Math.floor(gap / DAY)
    return {
      role: 'system',
      content: `距上次对话已超过 24 小时（约 ${days} 天）。此前的上下文信息可能已过时，涉及文件/代码细节请重新读取验证。`,
    }
  }

  cleanup(olderThanDays = 30): number {
    if (!existsSync(this.dir)) return 0
    let removed = 0
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl') || !SESSION_ID_RE.test(f.slice(0, -'.jsonl'.length))) continue
      const file = this.fileFor(f.slice(0, -'.jsonl'.length))
      if (!file) continue
      let mtime: number
      try {
        mtime = statSync(file).mtimeMs
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (Date.now() - mtime <= olderThanDays * DAY) continue
      withFileLock(`${file}.lock`, () => {
        if (!existsSync(file)) return
        const age = Date.now() - statSync(file).mtimeMs
        if (age <= olderThanDays * DAY) return
        rmSync(file, { force: true })
        this.countCache.delete(file)
        this.writeSnapshots.delete(file)
        this.receiptCache.delete(file)
        this.receiptSnapshots.delete(file)
        removed++
      })
    }
    return removed
  }

  latestStats(): { id: string; count: number } | null {
    const latest = this.recoverLatest()
    if (!latest) return null
    return { id: latest.id, count: latest.messages.length }
  }
}
