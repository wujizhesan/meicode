import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ChatMessage } from '../provider/types.ts'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

interface SessionCountSnapshot {
  size: number
  mtimeMs: number
  ctimeMs: number
  count: number
}

function matchesSnapshot(snapshot: SessionCountSnapshot, stats: { size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return snapshot.size === stats.size && snapshot.mtimeMs === stats.mtimeMs && snapshot.ctimeMs === stats.ctimeMs
}

function countNonEmptyLines(content: Buffer): number {
  let count = 0
  let hasContent = false
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === 10) {
      if (hasContent) count++
      hasContent = false
    } else if (char !== 13 && char !== 32 && char !== 9) {
      hasContent = true
    }
  }
  return count + (hasContent ? 1 : 0)
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
  private dirReady = false

  constructor(dir: string) {
    this.dir = dir
  }

  private ensureDir(): void {
    if (this.dirReady) return
    mkdirSync(this.dir, { recursive: true })
    this.dirReady = true
  }

  private fileFor(id: string): string | null {
    if (!SESSION_ID_RE.test(id)) return null
    const root = resolve(this.dir)
    const file = resolve(join(root, `${id}.jsonl`))
    if (file !== root && !file.startsWith(root + sep)) return null
    try {
      if (lstatSync(file).isSymbolicLink()) return null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    return file
  }

  append(id: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return
    const file = this.fileFor(id)
    if (!file) throw new Error('非法会话 ID')
    this.ensureDir()
    let before: ReturnType<typeof statSync> | null = null
    try {
      before = statSync(file)
    } catch {
    }
    const cached = this.countCache.get(file)
    const content = messages.map((message) => JSON.stringify(message)).join('\n') + '\n'
    try {
      appendFileSync(file, content, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.dirReady = false
      this.countCache.delete(file)
      this.ensureDir()
      before = null
      appendFileSync(file, content, 'utf8')
    }
    const after = statSync(file)
    if (!before) {
      this.countCache.set(file, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, count: messages.length })
    } else if (cached && matchesSnapshot(cached, before)) {
      this.countCache.set(file, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, count: cached.count + messages.length })
    } else {
      this.countCache.delete(file)
    }
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
    let lineCount = 0
    let needsSanitization = false
    let lineStart = 0
    while (lineStart < raw.length) {
      const newline = raw.indexOf('\n', lineStart)
      const lineEnd = newline < 0 ? raw.length : newline
      const line = raw.slice(lineStart, lineEnd)
      lineStart = lineEnd + 1
      if (!line.trim()) continue
      lineCount++
      try {
        const message = JSON.parse(line) as ChatMessage
        messages.push(message)
        if (message.role === 'tool' || (message.role === 'assistant' && message.tool_calls?.length)) needsSanitization = true
      } catch {
        continue // 坏行跳过
      }
    }
    this.countCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, count: lineCount })
    if (!needsSanitization) return { id, messages }

    // 截断：从尾部回溯，找到最后一个完整的「assistant(tool_calls) → tool 结果」轮
    let cut = messages.length
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'tool') {
        // tool 消息需要前驱 assistant(tool_calls) 配对
        const prev = messages[i - 1]
        if (!prev || prev.role !== 'assistant' || !prev.tool_calls?.some((t) => t.id === m.tool_call_id)) {
          cut = i
        }
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        // assistant 带 tool_calls 但后续没有 tool 结果 → 截断
        const next = messages[i + 1]
        if (!next || next.role !== 'tool') {
          cut = i
        }
      }
    }
    // 只截断到最后一个不完整轮之前（保留前面的完整轮）
    while (cut > 0 && cut < messages.length && messages[cut - 1].role === 'tool') {
      cut--
    }

    return { id, messages: sanitizeMessages(messages.slice(0, cut)) }
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
    if (!file || !existsSync(file)) return false
    rmSync(file, { force: true })
    this.countCache.delete(file)
    return true
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
      const age = Date.now() - statSync(file).mtimeMs
      if (age > olderThanDays * DAY) {
        rmSync(file, { force: true })
        this.countCache.delete(file)
        removed++
      }
    }
    return removed
  }

  latestStats(): { id: string; count: number } | null {
    const latest = this.recoverLatest()
    if (!latest) return null
    return { id: latest.id, count: latest.messages.length }
  }
}
