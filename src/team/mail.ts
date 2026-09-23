import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, renameSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { MailMessage } from './types.ts'
import { withLock } from './lock.ts'
import { createRuntimeId } from '../runtime/index.ts'
import { atomicWriteFile } from './atomic.ts'
import { isTeamActorName, teamActorKey } from './validation.ts'

const SUMMARY_LEN = 80

interface MailFileCache {
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  ino: number
  messages: MailMessage[]
  remainder: Buffer
  tail: Buffer
}

interface MailViewCache {
  directSource: readonly MailMessage[]
  directLength: number
  direct: MailMessage[]
  broadcastSource: readonly MailMessage[]
  broadcastLength: number
  broadcast: MailMessage[]
  messages: MailMessage[]
}

interface MailRegistryCache {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  registry: Record<string, string>
}

const CACHE_TAIL_BYTES = 64
const EMPTY_MAIL_MESSAGES: readonly MailMessage[] = Object.freeze([])

function emptyRegistry(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function cloneRegistry(registry: Record<string, string>): Record<string, string> {
  return Object.assign(emptyRegistry(), registry)
}

function isMailMessage(value: unknown): value is MailMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (typeof message.from !== 'string' || !message.from || typeof message.to !== 'string' || !message.to) return false
  if (typeof message.body !== 'string' || typeof message.ts !== 'number' || !Number.isFinite(message.ts) || typeof message.read !== 'boolean') return false
  for (const key of ['messageId', 'groupId', 'kind', 'taskId', 'correlationId', 'summary'] as const) {
    if (message[key] !== undefined && typeof message[key] !== 'string') return false
  }
  return true
}

function parseMailBytes(bytes: Buffer): { messages: MailMessage[]; remainder: Buffer } {
  const messages: MailMessage[] = []
  let lineStart = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue
    const line = bytes.subarray(lineStart, i).toString('utf8').trim()
    lineStart = i + 1
    if (!line) continue
    try {
      const message: unknown = JSON.parse(line)
      if (isMailMessage(message)) messages.push(message)
    } catch {
    }
  }
  return { messages, remainder: Buffer.from(bytes.subarray(lineStart)) }
}

function compareMailMessages(a: MailMessage, b: MailMessage): number {
  return a.ts - b.ts
}

function mergeSortedMessages(existing: MailMessage[], incoming: MailMessage[]): MailMessage[] {
  if (incoming.length === 0) return existing
  incoming.sort(compareMailMessages)
  if (existing.length === 0) return incoming
  if (existing[existing.length - 1].ts <= incoming[0].ts) {
    for (const message of incoming) existing.push(message)
    return existing
  }
  const merged = new Array<MailMessage>(existing.length + incoming.length)
  let left = 0
  let right = 0
  let target = 0
  while (left < existing.length && right < incoming.length) {
    merged[target++] = existing[left].ts <= incoming[right].ts ? existing[left++] : incoming[right++]
  }
  while (left < existing.length) merged[target++] = existing[left++]
  while (right < incoming.length) merged[target++] = incoming[right++]
  return merged
}

function filterMailboxMessages(messages: readonly MailMessage[], start: number, name: string, target: MailMessage[]): void {
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]
    if (message.to === name || message.from === name || message.to === '*') target.push(message)
  }
}

function mergeMessageViews(left: readonly MailMessage[], right: readonly MailMessage[]): MailMessage[] {
  if (left.length === 0) return [...right]
  if (right.length === 0) return [...left]
  const merged = new Array<MailMessage>(left.length + right.length)
  let leftIndex = 0
  let rightIndex = 0
  let target = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    merged[target++] = left[leftIndex].ts <= right[rightIndex].ts ? left[leftIndex++] : right[rightIndex++]
  }
  while (leftIndex < left.length) merged[target++] = left[leftIndex++]
  while (rightIndex < right.length) merged[target++] = right[rightIndex++]
  return merged
}

function findNewMessage(
  direct: readonly MailMessage[],
  directStart: number,
  broadcast: readonly MailMessage[],
  broadcastStart: number,
  name: string,
  predicate: (message: MailMessage) => boolean,
): MailMessage | undefined {
  let directIndex = directStart
  let broadcastIndex = broadcastStart
  while (directIndex < direct.length || broadcastIndex < broadcast.length) {
    while (directIndex < direct.length && direct[directIndex].to !== name && direct[directIndex].from !== name && direct[directIndex].to !== '*') directIndex++
    while (broadcastIndex < broadcast.length && broadcast[broadcastIndex].to !== name && broadcast[broadcastIndex].from !== name && broadcast[broadcastIndex].to !== '*') broadcastIndex++
    if (directIndex >= direct.length && broadcastIndex >= broadcast.length) return undefined
    const message = broadcastIndex >= broadcast.length || (directIndex < direct.length && direct[directIndex].ts <= broadcast[broadcastIndex].ts)
      ? direct[directIndex++]
      : broadcast[broadcastIndex++]
    const candidate = { ...message }
    if (predicate(candidate)) return candidate
  }
  return undefined
}

function readFileRange(file: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const fd = openSync(file, 'r')
  const bytes = Buffer.allocUnsafe(length)
  let offset = 0
  try {
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, start + offset)
      if (count === 0) break
      offset += count
    }
  } finally {
    closeSync(fd)
  }
  return offset === length ? bytes : bytes.subarray(0, offset)
}

export class TeamMail {
  private mailDir: string
  private waiters = new Map<string, Set<(message?: MailMessage) => void>>()
  private watcher: FSWatcher | undefined
  private fileCache = new Map<string, MailFileCache>()
  private viewCache = new Map<string, MailViewCache>()
  private registryCache?: MailRegistryCache
  private dirReady = false

  constructor(mailDir: string) {
    this.mailDir = mailDir
  }

  private ensureMailDir(): void {
    if (this.dirReady) return
    mkdirSync(this.mailDir, { recursive: true })
    this.dirReady = true
  }

  private registryFile(): string {
    return join(this.mailDir, 'registry.json')
  }

  private mailboxFile(name: string): string {
    return join(this.mailDir, `${name}.mail`)
  }

  // 注册表：name → 邮箱文件
  register(name: string): void {
    if (!isTeamActorName(name)) {
      console.warn(`[团队] 非法邮箱注册名，跳过: ${name}`)
      return
    }
    const mailbox = this.mailboxFile(name)
    this.ensureMailDir()
    withLock(join(this.mailDir, 'registry.lock'), () => {
      const reg = this.readRegistry()
      const conflict = Object.keys(reg).find((current) => teamActorKey(current) === teamActorKey(name) && current !== name)
      if (conflict) throw new Error(`邮箱名大小写冲突: ${name} 与 ${conflict}`)
      if (reg[name] === mailbox) return
      reg[name] = mailbox
      atomicWriteFile(this.registryFile(), JSON.stringify(reg, null, 2))
      this.registryCache = undefined
    })
  }

  private readRegistry(): Record<string, string> {
    const file = this.registryFile()
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`无法读取邮箱注册表: ${file}: ${(error as Error).message}`)
      }
      this.registryCache = undefined
      return emptyRegistry()
    }
    const cached = this.registryCache
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
      return cloneRegistry(cached.registry)
    }
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根节点不是对象')
      const registry = emptyRegistry()
      const names = new Map<string, string>()
      for (const [name, mailbox] of Object.entries(value)) {
        if (!isTeamActorName(name) || typeof mailbox !== 'string' || mailbox.length === 0) throw new Error(`非法邮箱记录: ${name}`)
        const key = teamActorKey(name)
        const existing = names.get(key)
        if (existing && existing !== name) throw new Error(`邮箱名大小写冲突: ${name} 与 ${existing}`)
        names.set(key, name)
        registry[name] = mailbox
      }
      this.registryCache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, registry }
      return cloneRegistry(registry)
    } catch (error) {
      this.registryCache = undefined
      const backup = `${file}.corrupt.${Date.now()}.${process.pid}.json`
      try {
        renameSync(file, backup)
      } catch {
      }
      throw new Error(`邮箱注册表损坏，已拒绝覆盖并隔离到 ${backup}: ${(error as Error).message}`)
    }
  }

  // 收件人名校验：防模型传 ..\ 路径注入（join 出 .meicode 目录）
  // 发送：目标邮箱 append JSONL（to='*' → broadcast.mail）
  send(from: string, to: string, body: string, metadata: Pick<MailMessage, 'groupId' | 'kind' | 'taskId' | 'correlationId'> = {}): void {
    if (to !== '*' && !isTeamActorName(to)) {
      console.warn(`[团队] 非法收件人名，丢弃: ${to}`)
      return
    }
    if (!isTeamActorName(from)) {
      console.warn(`[团队] 非法发件人名，丢弃: ${from}`)
      return
    }
    this.ensureMailDir()
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
    this.notify(to === '*' ? '*' : to, msg)
  }

  waitForMessage(name: string, predicate: (message: MailMessage) => boolean, timeoutMs = 0, signal?: AbortSignal): Promise<MailMessage | null> {
    if (!isTeamActorName(name)) return Promise.resolve(null)
    this.ensureMailDir()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortHandler: (() => void) | undefined
      let settled = false
      let initialized = false
      let directSource: readonly MailMessage[] = EMPTY_MAIL_MESSAGES
      let directLength = 0
      let broadcastSource: readonly MailMessage[] = EMPTY_MAIL_MESSAGES
      let broadcastLength = 0
      let check: (message?: MailMessage) => void
      const finish = (message: MailMessage | null): void => {
        if (settled) return
        settled = true
        const listeners = this.waiters.get(name)
        listeners?.delete(check)
        if (listeners?.size === 0) this.waiters.delete(name)
        if (this.waiters.size === 0) {
          this.watcher?.close()
          this.watcher = undefined
        }
        if (timer) clearTimeout(timer)
        if (abortHandler) signal?.removeEventListener('abort', abortHandler)
        resolve(message)
      }
      const matches = (candidate: MailMessage): boolean => {
        try {
          return predicate(candidate)
        } catch (error) {
          console.warn(`[团队] 邮件等待谓词异常: ${(error as Error).message}`)
          finish(null)
          return false
        }
      }
      check = (message?: MailMessage): void => {
        if (message) {
          const candidate = { ...message }
          if ((candidate.to === name || candidate.from === name || candidate.to === '*') && matches(candidate)) finish(candidate)
          return
        }
        if (!initialized) {
          for (const existing of this.readView(name)) {
            const candidate = { ...existing }
            if (matches(candidate)) {
              finish(candidate)
              return
            }
            if (settled) return
          }
          directSource = this.readFileMessages(this.mailboxFile(name))
          directLength = directSource.length
          broadcastSource = this.readFileMessages(join(this.mailDir, 'broadcast.mail'))
          broadcastLength = broadcastSource.length
          initialized = true
          return
        }
        const nextDirect = this.readFileMessages(this.mailboxFile(name))
        const nextBroadcast = this.readFileMessages(join(this.mailDir, 'broadcast.mail'))
        const directStart = nextDirect === directSource && directLength <= nextDirect.length ? directLength : 0
        const broadcastStart = nextBroadcast === broadcastSource && broadcastLength <= nextBroadcast.length ? broadcastLength : 0
        directSource = nextDirect
        directLength = nextDirect.length
        broadcastSource = nextBroadcast
        broadcastLength = nextBroadcast.length
        const candidate = findNewMessage(nextDirect, directStart, nextBroadcast, broadcastStart, name, matches)
        if (candidate) finish(candidate)
      }
      const listeners = this.waiters.get(name) ?? new Set<(message?: MailMessage) => void>()
      listeners.add(check)
      this.waiters.set(name, listeners)
      this.ensureWatcher()
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

  private ensureWatcher(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.mailDir, { persistent: false }, () => this.notify('*'))
    } catch {
    }
  }

  private notify(name: string, message?: MailMessage): void {
    const notifyListeners = (listeners: Iterable<(message?: MailMessage) => void>): void => {
      for (const listener of [...listeners]) {
        try {
          listener(message)
        } catch (error) {
          console.warn(`[团队] 邮件监听器异常: ${(error as Error).message}`)
        }
      }
    }
    if (name === '*') {
      for (const listeners of [...this.waiters.values()]) notifyListeners(listeners)
      return
    }
    notifyListeners(this.waiters.get(name) ?? [])
    notifyListeners(this.waiters.get('*') ?? [])
  }

  // 读取：自己邮箱 + 广播，过滤（to=自己/from=自己/广播），按 ts 排序
  private readFileMessages(file: string): readonly MailMessage[] {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(file)
    } catch {
      this.fileCache.delete(file)
      return EMPTY_MAIL_MESSAGES
    }
    const cached = this.fileCache.get(file)
    const sameFile = cached && cached.ino === stats.ino && cached.birthtimeMs === stats.birthtimeMs
    if (sameFile && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs) {
      return cached.messages
    }
    if (sameFile && stats.size > cached.size) {
      const start = Math.max(0, cached.size - cached.tail.length)
      const bytes = readFileRange(file, start, stats.size - start)
      const oldTail = bytes.subarray(0, cached.tail.length)
      if (bytes.length === stats.size - start && oldTail.equals(cached.tail)) {
        const appended = bytes.subarray(cached.tail.length)
        const pending = cached.remainder.length > 0 ? Buffer.concat([cached.remainder, appended]) : appended
        const parsed = parseMailBytes(pending)
        cached.messages = mergeSortedMessages(cached.messages, parsed.messages)
        cached.size = stats.size
        cached.mtimeMs = stats.mtimeMs
        cached.ctimeMs = stats.ctimeMs
        cached.remainder = parsed.remainder
        cached.tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - CACHE_TAIL_BYTES)))
        return cached.messages
      }
    }
    const bytes = readFileSync(file)
    const parsed = parseMailBytes(bytes)
    parsed.messages.sort(compareMailMessages)
    const after = statSync(file)
    this.fileCache.set(file, {
      size: bytes.length,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      birthtimeMs: after.birthtimeMs,
      ino: after.ino,
      messages: parsed.messages,
      remainder: parsed.remainder,
      tail: Buffer.from(bytes.subarray(Math.max(0, bytes.length - CACHE_TAIL_BYTES))),
    })
    return parsed.messages
  }

  private readView(name: string): readonly MailMessage[] {
    const direct = this.readFileMessages(this.mailboxFile(name))
    const broadcast = this.readFileMessages(join(this.mailDir, 'broadcast.mail'))
    let view = this.viewCache.get(name)
    let changed = false
    if (!view) {
      const directMessages: MailMessage[] = []
      const broadcastMessages: MailMessage[] = []
      filterMailboxMessages(direct, 0, name, directMessages)
      filterMailboxMessages(broadcast, 0, name, broadcastMessages)
      view = {
        directSource: direct,
        directLength: direct.length,
        direct: directMessages,
        broadcastSource: broadcast,
        broadcastLength: broadcast.length,
        broadcast: broadcastMessages,
        messages: mergeMessageViews(directMessages, broadcastMessages),
      }
      this.viewCache.set(name, view)
    } else {
      if (view.directSource === direct && view.directLength <= direct.length) {
        if (view.directLength < direct.length) {
          filterMailboxMessages(direct, view.directLength, name, view.direct)
          view.directLength = direct.length
          changed = true
        }
      } else {
        view.directSource = direct
        view.directLength = direct.length
        view.direct = []
        filterMailboxMessages(direct, 0, name, view.direct)
        changed = true
      }
      if (view.broadcastSource === broadcast && view.broadcastLength <= broadcast.length) {
        if (view.broadcastLength < broadcast.length) {
          filterMailboxMessages(broadcast, view.broadcastLength, name, view.broadcast)
          view.broadcastLength = broadcast.length
          changed = true
        }
      } else {
        view.broadcastSource = broadcast
        view.broadcastLength = broadcast.length
        view.broadcast = []
        filterMailboxMessages(broadcast, 0, name, view.broadcast)
        changed = true
      }
      if (changed) view.messages = mergeMessageViews(view.direct, view.broadcast)
    }
    return view.messages
  }

  read(name: string, markRead = false): MailMessage[] {
    if (!isTeamActorName(name)) return []
    const out = this.readView(name).map((message) => ({ ...message }))
    if (markRead) {
      const unread = out.filter((message) => !message.read && (message.to === name || message.to === '*'))
      if (unread.length > 0) this.markRead(name, unread)
    }
    return out
  }

  private markRead(name: string, msgs: MailMessage[]): void {
    // 复合键 ts:from——同毫秒多条消息不会被误标（仅按 ts 会一起标记）
    const keyFor = (msg: MailMessage): string => msg.messageId ? `id:${msg.messageId}` : `legacy:${msg.ts}:${msg.from}:${msg.body}`
    const targets: Array<[string, MailMessage[]]> = [
      [this.mailboxFile(name), msgs.filter((message) => message.to !== '*')],
      [join(this.mailDir, 'broadcast.mail'), msgs.filter((message) => message.to === '*')],
    ]
    withLock(join(this.mailDir, '.lock'), () => {
      for (const [file, messages] of targets) {
        if (messages.length === 0 || !existsSync(file)) continue
        const keys = new Set(messages.map(keyFor))
        let changed = false
        const refreshedMessages: MailMessage[] = []
        let refreshedSorted = true
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        const updated = lines.map((line) => {
          try {
            const parsed: unknown = JSON.parse(line)
            if (!isMailMessage(parsed)) return line
            const msg = parsed
            let lineChanged = false
            if (!msg.read && keys.has(keyFor(msg))) {
              msg.read = true
              changed = true
              lineChanged = true
            }
            if (refreshedMessages.length > 0 && refreshedMessages[refreshedMessages.length - 1].ts > msg.ts) refreshedSorted = false
            refreshedMessages.push(msg)
            return lineChanged ? JSON.stringify(msg) : line
          } catch {
            return line
          }
        })
        if (!changed) continue
        const content = updated.join('\n') + (updated.length ? '\n' : '')
        atomicWriteFile(file, content)
        if (!refreshedSorted) refreshedMessages.sort(compareMailMessages)
        const tailBytes = Buffer.from(content.slice(-CACHE_TAIL_BYTES * 4))
        const after = statSync(file)
        this.fileCache.set(file, {
          size: after.size,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          birthtimeMs: after.birthtimeMs,
          ino: after.ino,
          messages: refreshedMessages,
          remainder: Buffer.alloc(0),
          tail: Buffer.from(tailBytes.subarray(Math.max(0, tailBytes.length - CACHE_TAIL_BYTES))),
        })
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
