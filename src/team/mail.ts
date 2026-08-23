import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { MailMessage } from './types.ts'
import { withLock } from './lock.ts'
import { createRuntimeId } from '../runtime/index.ts'
import { atomicWriteFile } from './atomic.ts'

const SUMMARY_LEN = 80

export class TeamMail {
  private mailDir: string
  private waiters = new Map<string, Set<() => void>>()

  constructor(mailDir: string) {
    this.mailDir = mailDir
    mkdirSync(mailDir, { recursive: true })
  }

  private registryFile(): string {
    return join(this.mailDir, 'registry.json')
  }

  private mailboxFile(name: string): string {
    return join(this.mailDir, `${name}.mail`)
  }

  // 注册表：name → 邮箱文件
  register(name: string): void {
    if (!TeamMail.validName(name)) {
      console.warn(`[团队] 非法邮箱注册名，跳过: ${name}`)
      return
    }
    withLock(join(this.mailDir, 'registry.lock'), () => {
      const reg = this.readRegistry()
      reg[name] = this.mailboxFile(name)
      atomicWriteFile(this.registryFile(), JSON.stringify(reg, null, 2))
    })
  }

  private readRegistry(): Record<string, string> {
    if (!existsSync(this.registryFile())) return {}
    try {
      return JSON.parse(readFileSync(this.registryFile(), 'utf8'))
    } catch {
      return {}
    }
  }

  // 收件人名校验：防模型传 ..\ 路径注入（join 出 .mewcode 目录）
  private static validName(name: string): boolean {
    return /^[A-Za-z0-9_-]{1,64}$/.test(name)
  }

  // 发送：目标邮箱 append JSONL（to='*' → broadcast.mail）
  send(from: string, to: string, body: string, metadata: Pick<MailMessage, 'groupId' | 'kind' | 'taskId' | 'correlationId'> = {}): void {
    if (to !== '*' && !TeamMail.validName(to)) {
      console.warn(`[团队] 非法收件人名，丢弃: ${to}`)
      return
    }
    if (!TeamMail.validName(from)) {
      console.warn(`[团队] 非法发件人名，丢弃: ${from}`)
      return
    }
    const msg: MailMessage = {
      messageId: createRuntimeId('message'),
      ...metadata,
      from,
      to,
      body,
      ts: Date.now(),
      read: false,
      summary: body.split('\n')[0].slice(0, SUMMARY_LEN),
    }
    const target = to === '*' ? join(this.mailDir, 'broadcast.mail') : this.mailboxFile(to)
    withLock(join(this.mailDir, '.lock'), () => {
      appendFileSync(target, JSON.stringify(msg) + '\n', 'utf8')
    })
    this.notify(to === '*' ? '*' : to)
  }

  waitForMessage(name: string, predicate: (message: MailMessage) => boolean, timeoutMs = 0, signal?: AbortSignal): Promise<MailMessage | null> {
    if (!TeamMail.validName(name)) return Promise.resolve(null)
    return new Promise((resolve) => {
      let watcher: FSWatcher | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortHandler: (() => void) | undefined
      const check = (): void => {
        const message = this.read(name).find(predicate)
        if (message) finish(message)
      }
      const finish = (message: MailMessage | null): void => {
        const listeners = this.waiters.get(name)
        listeners?.delete(check)
        if (listeners?.size === 0) this.waiters.delete(name)
        watcher?.close()
        if (timer) clearTimeout(timer)
        if (abortHandler) signal?.removeEventListener('abort', abortHandler)
        resolve(message)
      }
      const listeners = this.waiters.get(name) ?? new Set<() => void>()
      listeners.add(check)
      this.waiters.set(name, listeners)
      try {
        watcher = watch(this.mailDir, { persistent: false }, () => check())
      } catch {
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(null), timeoutMs)
      }
      if (signal) {
        abortHandler = () => finish(null)
        if (signal.aborted) {
          finish(null)
          return
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }
      check()
    })
  }

  private notify(name: string): void {
    if (name === '*') {
      for (const listeners of this.waiters.values()) for (const listener of listeners) listener()
      return
    }
    for (const listener of this.waiters.get(name) ?? []) listener()
    for (const listener of this.waiters.get('*') ?? []) listener()
  }

  // 读取：自己邮箱 + 广播，过滤（to=自己/from=自己/广播），按 ts 排序
  read(name: string, markRead = false): MailMessage[] {
    if (!TeamMail.validName(name)) return []
    const out: MailMessage[] = []
    const files = [this.mailboxFile(name), join(this.mailDir, 'broadcast.mail')]
    for (const file of files) {
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as MailMessage
          if (msg.to === name || msg.from === name || msg.to === '*') out.push(msg)
        } catch {
          // 坏行跳过
        }
      }
    }
    out.sort((a, b) => a.ts - b.ts)
    if (markRead) {
      this.markRead(name, out.filter((m) => m.to === name || m.to === '*'))
    }
    return out
  }

  private markRead(name: string, msgs: MailMessage[]): void {
    const files = [this.mailboxFile(name), join(this.mailDir, 'broadcast.mail')]
    // 复合键 ts:from——同毫秒多条消息不会被误标（仅按 ts 会一起标记）
    const keyFor = (msg: MailMessage): string => msg.messageId ? `id:${msg.messageId}` : `legacy:${msg.ts}:${msg.from}:${msg.body}`
    const keys = new Set(msgs.map(keyFor))
    withLock(join(this.mailDir, '.lock'), () => {
      for (const file of files) {
        if (!existsSync(file)) continue
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const updated = lines.map((line) => {
        try {
          const msg = JSON.parse(line) as MailMessage
          if (keys.has(keyFor(msg))) msg.read = true
          return JSON.stringify(msg)
        } catch {
          return line
        }
      })
        atomicWriteFile(file, updated.join('\n') + (updated.length ? '\n' : ''))
      }
    })
  }

  // 协议消息解析：首行 APPROVE/DENY/PROTO
  static parseProtocol(body: string): { type: 'APPROVE' | 'DENY' | 'PROTO' | 'PLAN' | 'ASSIGN' | 'IDLE' | 'TEXT'; rest: string } {
    const first = body.split('\n')[0].trim()
    const upper = first.toUpperCase()
    for (const t of ['APPROVE', 'DENY', 'PROTO', 'PLAN', 'ASSIGN', 'IDLE'] as const) {
      if (upper.startsWith(t)) return { type: t, rest: body.slice(first.length).trim() }
    }
    return { type: 'TEXT', rest: body }
  }
}

export function listMailboxes(mailDir: string): string[] {
  if (!existsSync(mailDir)) return []
  return readdirSync(mailDir)
    .filter((f) => f.endsWith('.mail'))
    .map((f) => f.replace(/\.mail$/, ''))
}
