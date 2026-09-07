import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ChatMessage } from '../provider/types.ts'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function countNonEmptyLines(text: string): number {
  let count = 0
  let hasContent = false
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
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

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
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
    appendFileSync(file, messages.map((message) => JSON.stringify(message)).join('\n') + '\n', 'utf8')
  }

  // 恢复：坏行跳过、工具调用无结果截断
  recoverLatest(): { id: string; messages: ChatMessage[] } | null {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl') && SESSION_ID_RE.test(f.slice(0, -'.jsonl'.length)))
      .sort()
      .reverse()
    if (files.length === 0) return null
    return this.recoverById(files[0].replace(/\.jsonl$/, ''))
  }

  recoverById(id: string): { id: string; messages: ChatMessage[] } | null {
    const file = this.fileFor(id)
    if (!file || !existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    const messages: ChatMessage[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        continue // 坏行跳过
      }
    }

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
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl') && SESSION_ID_RE.test(f.slice(0, -'.jsonl'.length)))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        const id = f.replace(/\.jsonl$/, '')
        const file = this.fileFor(id)
        if (!file) return { id, count: 0, mtime: 0 }
        const count = countNonEmptyLines(readFileSync(file, 'utf8'))
        let mtime = 0
        try {
          mtime = statSync(file).mtimeMs
        } catch {
          // 读取失败按 0
        }
        return { id, count, mtime }
      })
  }

  // 删除单个会话（当前会话由调用方防护）
  removeById(id: string): boolean {
    const file = this.fileFor(id)
    if (!file || !existsSync(file)) return false
    rmSync(file, { force: true })
    return true
  }

  // 距上次活动 >24h 的提醒消息
  timeGapMessage(id: string): ChatMessage | null {
    const file = this.fileFor(id)
    if (!file || !existsSync(file)) return null
    const mtime = statSync(file).mtimeMs
    const gap = Date.now() - mtime
    if (gap <= 24 * HOUR) return null
    const days = Math.floor(gap / DAY)
    return {
      role: 'system',
      content: `距上次对话已超过 24 小时（约 ${days} 天）。此前的上下文信息可能已过时，涉及文件/代码细节请重新读取验证。`,
    }
  }

  cleanup(olderThanDays = 30): number {
    let removed = 0
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl') || !SESSION_ID_RE.test(f.slice(0, -'.jsonl'.length))) continue
      const file = this.fileFor(f.slice(0, -'.jsonl'.length))
      if (!file) continue
      const age = Date.now() - statSync(file).mtimeMs
      if (age > olderThanDays * DAY) {
        rmSync(file, { force: true })
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
