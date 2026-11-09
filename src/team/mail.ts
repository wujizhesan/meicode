import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, renameSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { MailMessage } from './types.ts'
import { withLock } from './lock.ts'
import { createRuntimeId } from '../runtime/index.ts'
import { atomicWriteFile } from './atomic.ts'
import { isTeamActorName, teamActorKey } from './validation.ts'

const SUMMARY_LEN = 80

interface StoredMailMessage extends MailMessage {
  readBy?: string[]
}

interface MailFileCache {
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  ino: number
  messages: StoredMailMessage[]
  remainder: Buffer
  tail: Buffer
}

interface MailViewCache {
  directSource: readonly StoredMailMessage[]
  directLength: number
  direct: StoredMailMessage[]
  broadcastSource: readonly StoredMailMessage[]
  broadcastLength: number
  broadcast: StoredMailMessage[]
  messages: StoredMailMessage[]
}

interface MailRegistryCache {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  registry: Record<string, string>
}

export interface MailRegistrationResult {
  registered: Set<string>
  failures: Map<string, Error>
}

export interface MailPageOptions {
  unreadOnly?: boolean
  markRead?: boolean
  limit?: number
  cursor?: string
}

export interface MailPage {
  messages: MailMessage[]
  total: number
  unreadTotal: number
  nextCursor?: string
}

const CACHE_TAIL_BYTES = 64
const MAIL_POLL_MS = 250
const EMPTY_MAIL_MESSAGES: readonly StoredMailMessage[] = Object.freeze([])

function emptyRegistry(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function cloneRegistry(registry: Record<string, string>): Record<string, string> {
  return Object.assign(emptyRegistry(), registry)
}

function isMailMessage(value: unknown): value is StoredMailMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (typeof message.from !== 'string' || !message.from || typeof message.to !== 'string' || !message.to) return false
  if (typeof message.body !== 'string' || typeof message.ts !== 'number' || !Number.isFinite(message.ts) || typeof message.read !== 'boolean') return false
  for (const key of ['messageId', 'groupId', 'kind', 'taskId', 'correlationId', 'summary'] as const) {
    if (message[key] !== undefined && typeof message[key] !== 'string') return false
  }
  if (message.readBy !== undefined && (!Array.isArray(message.readBy)
    || message.readBy.some((name) => typeof name !== 'string' || !isTeamActorName(name)))) return false
  return true
}

function isReadBy(message: StoredMailMessage, name: string): boolean {
  return message.to === '*' && message.readBy !== undefined ? message.readBy.includes(name) : message.read
}

function mailboxMessage(message: StoredMailMessage, name: string): MailMessage {
  const { readBy, ...copy } = message
  return { ...copy, read: isReadBy(message, name) }
}

function parseMailBytes(bytes: Buffer): { messages: StoredMailMessage[]; remainder: Buffer } {
  const messages: StoredMailMessage[] = []
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

function mergeSortedMessages(existing: StoredMailMessage[], incoming: StoredMailMessage[]): StoredMailMessage[] {
  if (incoming.length === 0) return existing
  incoming.sort(compareMailMessages)
  if (existing.length === 0) return incoming
  if (existing[existing.length - 1].ts <= incoming[0].ts) {
    for (const message of incoming) existing.push(message)
    return existing
  }
  const merged = new Array<StoredMailMessage>(existing.length + incoming.length)
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

function isMailboxMessage(message: MailMessage, name: string, broadcastOnly = false): boolean {
  return message.to === '*' || (!broadcastOnly && (message.to === name || message.from === name))
}

function filterMailboxMessages(messages: readonly StoredMailMessage[], start: number, name: string, target: StoredMailMessage[], broadcastOnly = false): void {
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]
    if (isMailboxMessage(message, name, broadcastOnly)) target.push(message)
  }
}

function mergeMessageViews(left: readonly StoredMailMessage[], right: readonly StoredMailMessage[]): StoredMailMessage[] {
  if (left.length === 0) return [...right]
  if (right.length === 0) return [...left]
  const merged = new Array<StoredMailMessage>(left.length + right.length)
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
  direct: readonly StoredMailMessage[],
  directStart: number,
  broadcast: readonly StoredMailMessage[],
  broadcastStart: number,
  name: string,
  predicate: (message: MailMessage) => boolean,
): MailMessage | undefined {
  let directIndex = directStart
  let broadcastIndex = broadcastStart
  while (directIndex < direct.length || broadcastIndex < broadcast.length) {
    while (directIndex < direct.length && !isMailboxMessage(direct[directIndex], name)) directIndex++
    while (broadcastIndex < broadcast.length && !isMailboxMessage(broadcast[broadcastIndex], name, true)) broadcastIndex++
    if (directIndex >= direct.length && broadcastIndex >= broadcast.length) return undefined
    const message = broadcastIndex >= broadcast.length || (directIndex < direct.length && direct[directIndex].ts <= broadcast[broadcastIndex].ts)
      ? direct[directIndex++]
      : broadcast[broadcastIndex++]
    const candidate = mailboxMessage(message, name)
    if (predicate(candidate)) return candidate
  }
  return undefined
}

function matchesCursorAnchor(message: MailMessage, anchor: readonly unknown[]): boolean {
  return message.messageId === anchor[1] && message.from === anchor[2] && message.to === anchor[3] && message.ts === anchor[4]
}

function mailCursor(name: string, messages: readonly MailMessage[], index: number): string {
  const message = messages[index]
  if (!message.messageId) return `index:${index}`
  const anchor = [name, message.messageId, message.from, message.to, message.ts, 0]
  let occurrence = 0
  for (let before = 0; before < index; before++) if (matchesCursorAnchor(messages[before], anchor)) occurrence++
  anchor[5] = occurrence
  return `mail:${Buffer.from(JSON.stringify(anchor)).toString('base64url')}`
}

function mailCursorIndex(name: string, messages: readonly MailMessage[], cursor: string): number {
  if (cursor.startsWith('mail:')) {
    try {
      const encoded = cursor.slice(5)
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return -1
      const anchor: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
      if (!Array.isArray(anchor) || anchor.length !== 6 || anchor[0] !== name
        || anchor.slice(0, 4).some((item) => typeof item !== 'string' || !item)
        || typeof anchor[4] !== 'number' || !Number.isFinite(anchor[4])
        || !Number.isSafeInteger(anchor[5]) || anchor[5] < 0) return -1
      let occurrence = 0
      return messages.findIndex((message) => matchesCursorAnchor(message, anchor) && occurrence++ === anchor[5])
    } catch { return -1 }
  }
  if (cursor.startsWith('id:')) {
    let found = -1
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].messageId !== cursor.slice(3)) continue
      if (found >= 0) return -1
      found = index
    }
    return found
  }
  return /^index:\d+$/.test(cursor) ? Number(cursor.slice(6)) : -1
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

function sameMailFileVersion(before: Stats, after: Stats): boolean {
  return before.ino === after.ino && before.birthtimeMs === after.birthtimeMs && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

export class TeamMail {
  private mailDir: string
  private waiters = new Map<string, Set<(message?: MailMessage) => void>>()
  private watcher: FSWatcher | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
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
    const failure = this.registerMany([name]).failures.get(name)
    if (failure) throw failure
  }

  registerMany(names: readonly string[]): MailRegistrationResult {
    const result: MailRegistrationResult = { registered: new Set(), failures: new Map() }
    const validNames = new Set<string>()
    for (const name of names) {
      if (!isTeamActorName(name)) result.failures.set(name, new Error(`非法邮箱注册名: ${name}`))
      else validNames.add(name)
    }
    if (validNames.size === 0) return result
    this.ensureMailDir()
    withLock(join(this.mailDir, 'registry.lock'), () => {
      const reg = this.readRegistry()
      const existingNames = new Map(Object.keys(reg).map((name) => [teamActorKey(name), name]))
      let changed = false
      for (const name of validNames) {
        const key = teamActorKey(name)
        const conflict = existingNames.get(key)
        if (conflict && conflict !== name) {
          result.failures.set(name, new Error(`邮箱名大小写冲突: ${name} 与 ${conflict}`))
          continue
        }
        result.registered.add(name)
        const mailbox = this.mailboxFile(name)
        if (reg[name] === mailbox) continue
        reg[name] = mailbox
        existingNames.set(key, name)
        changed = true
      }
      if (changed) {
        atomicWriteFile(this.registryFile(), JSON.stringify(reg, null, 2))
        this.registryCache = undefined
      }
    })
    return result
  }

  private readRegistry(): Record<string, string> {
    const file = this.registryFile()
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(file)
    } catch (error) {
      this.registryCache = undefined
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`无法读取邮箱注册表: ${file}: ${(error as Error).message}`, { cause: error })
      }
      return emptyRegistry()
    }
    const cached = this.registryCache
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
      return cloneRegistry(cached.registry)
    }
    let content: string
    try { content = readFileSync(file, 'utf8') }
    catch (error) {
      this.registryCache = undefined
      throw new Error(`无法读取邮箱注册表: ${file}: ${(error as Error).message}`, { cause: error })
    }
    try {
      const value: unknown = JSON.parse(content)
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
      } catch (isolationError) {
        throw new Error(`邮箱注册表损坏，已拒绝覆盖，隔离失败，原文件保留在 ${file}: ${(error as Error).message}；${(isolationError as Error).message}`, {
          cause: new AggregateError([error, isolationError]),
        })
      }
      throw new Error(`邮箱注册表损坏，已拒绝覆盖并隔离到 ${backup}: ${(error as Error).message}`, { cause: error })
    }
  }

  // 收件人名校验：防模型传 ..\ 路径注入（join 出 .meicode 目录）
  // 发送：目标邮箱 append JSONL（to='*' → broadcast.mail）
  send(from: string, to: string, body: string, metadata: Pick<MailMessage, 'groupId' | 'kind' | 'taskId' | 'correlationId'> & Partial<Pick<MailMessage, 'messageId' | 'ts'>> = {}): void {
    if (to !== '*' && !isTeamActorName(to)) {
      console.warn(`[团队] 非法收件人名，丢弃: ${to}`)
      return
    }
    if (!isTeamActorName(from)) {
      console.warn(`[团队] 非法发件人名，丢弃: ${from}`)
      return
    }
    this.ensureMailDir()
    const msg: StoredMailMessage = {
      messageId: metadata.messageId ?? createRuntimeId('message'),
      ...metadata,
      from,
      to,
      body,
      ts: metadata.ts ?? Date.now(),
      read: false,
      ...(to === '*' ? { readBy: [] } : {}),
      summary: body.split('\n')[0].slice(0, SUMMARY_LEN),
    }
    const target = to === '*' ? join(this.mailDir, 'broadcast.mail') : this.mailboxFile(to)
    let sent = false
    withLock(join(this.mailDir, '.lock'), () => {
      let messages = this.readFileMessages(target)
      if (this.fileCache.get(target)?.remainder.length) {
        appendFileSync(target, '\n', 'utf8')
        messages = this.readFileMessages(target)
      }
      if (metadata.messageId && messages.some((message) => message.messageId === metadata.messageId && message.to === to)) return
      appendFileSync(target, JSON.stringify(msg) + '\n', 'utf8')
      sent = true
    })
    if (sent) this.notify(to === '*' ? '*' : to, msg)
  }

  waitForMessage(name: string, predicate: (message: MailMessage) => boolean, timeoutMs = 0, signal?: AbortSignal): Promise<MailMessage | null> {
    if (!isTeamActorName(name) || signal?.aborted) return Promise.resolve(null)
    this.ensureMailDir()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortHandler: (() => void) | undefined
      let settled = false
      let initialized = false
      let directSource: readonly StoredMailMessage[] = EMPTY_MAIL_MESSAGES
      let directLength = 0
      let broadcastSource: readonly StoredMailMessage[] = EMPTY_MAIL_MESSAGES
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
          clearInterval(this.pollTimer)
          this.pollTimer = undefined
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
        if (settled) return
        if (message) {
          const candidate = mailboxMessage(message, name)
          if ((candidate.to === name || candidate.from === name || candidate.to === '*') && matches(candidate)) finish(candidate)
          return
        }
        try {
          if (!initialized) {
            for (const existing of this.readView(name)) {
              const candidate = mailboxMessage(existing, name)
              if (matches(candidate)) {
                finish(candidate)
                return
              }
              if (settled) return
            }
            const view = this.viewCache.get(name)!
            directSource = view.directSource
            directLength = view.directLength
            broadcastSource = view.broadcastSource
            broadcastLength = view.broadcastLength
            initialized = true
            return
          }
          const { direct: nextDirect, broadcast: nextBroadcast } = this.readSources(name)
          const directStart = nextDirect === directSource && directLength <= nextDirect.length ? directLength : 0
          const broadcastStart = nextBroadcast === broadcastSource && broadcastLength <= nextBroadcast.length ? broadcastLength : 0
          directSource = nextDirect
          directLength = nextDirect.length
          broadcastSource = nextBroadcast
          broadcastLength = nextBroadcast.length
          const candidate = findNewMessage(nextDirect, directStart, nextBroadcast, broadcastStart, name, matches)
          if (candidate) finish(candidate)
        } catch { initialized = false }
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
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.notify('*'), MAIL_POLL_MS)
      this.pollTimer.unref()
    }
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
  private readFileMessages(file: string): readonly StoredMailMessage[] {
    for (let attempt = 0; attempt < 3; attempt++) {
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(file)
      } catch (error) {
        this.fileCache.delete(file)
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return EMPTY_MAIL_MESSAGES
      }
      const cached = this.fileCache.get(file)
      const sameFile = cached && cached.ino === stats.ino && cached.birthtimeMs === stats.birthtimeMs
      if (sameFile && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs) {
        return cached.messages
      }
      try {
        if (sameFile && stats.size > cached.size) {
          const start = Math.max(0, cached.size - cached.tail.length)
          const bytes = readFileRange(file, start, stats.size - start)
          if (bytes.length !== stats.size - start || !sameMailFileVersion(stats, statSync(file))) {
            this.fileCache.delete(file)
            continue
          }
          const oldTail = bytes.subarray(0, cached.tail.length)
          if (oldTail.equals(cached.tail)) {
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
        if (bytes.length !== stats.size || !sameMailFileVersion(stats, statSync(file))) {
          this.fileCache.delete(file)
          continue
        }
        const parsed = parseMailBytes(bytes)
        parsed.messages.sort(compareMailMessages)
        this.fileCache.set(file, {
          size: bytes.length,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          birthtimeMs: stats.birthtimeMs,
          ino: stats.ino,
          messages: parsed.messages,
          remainder: parsed.remainder,
          tail: Buffer.from(bytes.subarray(Math.max(0, bytes.length - CACHE_TAIL_BYTES))),
        })
        return parsed.messages
      } catch (error) {
        this.fileCache.delete(file)
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error(`邮箱读取期间持续变化，请重试: ${file}`)
  }

  private readSources(name: string): { direct: readonly StoredMailMessage[]; broadcast: readonly StoredMailMessage[] } {
    const directFile = this.mailboxFile(name), broadcastFile = join(this.mailDir, 'broadcast.mail')
    const sameFile = process.platform === 'win32' ? directFile.toLowerCase() === broadcastFile.toLowerCase() : directFile === broadcastFile
    return {
      direct: this.readFileMessages(directFile),
      broadcast: sameFile ? EMPTY_MAIL_MESSAGES : this.readFileMessages(broadcastFile),
    }
  }

  private readView(name: string): readonly StoredMailMessage[] {
    const { direct, broadcast } = this.readSources(name)
    let view = this.viewCache.get(name)
    let changed = false
    if (!view) {
      const directMessages: StoredMailMessage[] = []
      const broadcastMessages: StoredMailMessage[] = []
      filterMailboxMessages(direct, 0, name, directMessages)
      filterMailboxMessages(broadcast, 0, name, broadcastMessages, true)
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
          filterMailboxMessages(broadcast, view.broadcastLength, name, view.broadcast, true)
          view.broadcastLength = broadcast.length
          changed = true
        }
      } else {
        view.broadcastSource = broadcast
        view.broadcastLength = broadcast.length
        view.broadcast = []
        filterMailboxMessages(broadcast, 0, name, view.broadcast, true)
        changed = true
      }
      if (changed) view.messages = mergeMessageViews(view.direct, view.broadcast)
    }
    return view.messages
  }

  read(name: string, markRead = false): MailMessage[] {
    if (!isTeamActorName(name)) return []
    const out = this.readView(name).map((message) => mailboxMessage(message, name))
    if (markRead) {
      const unread = out.filter((message) => !message.read && (message.to === name || message.to === '*'))
      if (unread.length > 0) this.markRead(name, unread)
    }
    return out
  }

  readPage(name: string, options: MailPageOptions = {}): MailPage {
    if (!isTeamActorName(name)) return { messages: [], total: 0, unreadTotal: 0 }
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('邮件每页数量必须在 1-100 之间')
    const view = this.readView(name)
    let end = view.length
    if (options.cursor !== undefined) {
      end = mailCursorIndex(name, view, options.cursor)
      if (!Number.isSafeInteger(end) || end < 0 || end > view.length) throw new Error('邮件分页游标无效或已过期')
    }
    let unreadTotal = 0
    for (const message of view) if (!isReadBy(message, name)) unreadTotal++
    const messages: MailMessage[] = []
    let lastIndex = -1
    let nextCursor: string | undefined
    for (let index = end - 1; index >= 0; index--) {
      const message = view[index]
      if (options.unreadOnly && isReadBy(message, name)) continue
      if (messages.length === limit) {
        nextCursor = mailCursor(name, view, lastIndex)
        break
      }
      messages.push(mailboxMessage(message, name))
      lastIndex = index
    }
    if (options.markRead) {
      const unread = messages.filter((message) => !message.read && (message.to === name || message.to === '*'))
      if (unread.length > 0) this.markRead(name, unread)
    }
    return { messages, total: view.length, unreadTotal, nextCursor }
  }

  private markRead(name: string, msgs: MailMessage[]): void {
    const keyFor = (msg: MailMessage): string => JSON.stringify([
      msg.messageId ?? null, msg.ts, msg.from, msg.to, msg.body, msg.groupId ?? null, msg.kind ?? null, msg.taskId ?? null, msg.correlationId ?? null,
    ])
    const targets: Array<[string, MailMessage[]]> = [
      [this.mailboxFile(name), msgs.filter((message) => message.to !== '*')],
      [join(this.mailDir, 'broadcast.mail'), msgs.filter((message) => message.to === '*')],
    ]
    withLock(join(this.mailDir, '.lock'), () => {
      for (const [file, messages] of targets) {
        if (messages.length === 0) continue
        const counts = new Map<string, number>()
        for (const message of messages) {
          const key = keyFor(message)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        let changed = false
        let bytes: Buffer
        try { bytes = readFileSync(file) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const completeEnd = bytes.lastIndexOf(10) + 1
        const lines = bytes.subarray(0, completeEnd).toString('utf8').split('\n').slice(0, -1)
        const parsedLines = lines.map((line): StoredMailMessage | null => {
          try {
            const parsed: unknown = JSON.parse(line)
            return isMailMessage(parsed) ? parsed : null
          } catch {
            return null
          }
        })
        const updated = [...lines]
        for (let index = parsedLines.length - 1; index >= 0; index--) {
          const message = parsedLines[index]
          if (!message || isReadBy(message, name)) continue
          const key = keyFor(message)
          const remaining = counts.get(key) ?? 0
          if (remaining === 0) continue
          if (message.to === '*') message.readBy = [...(message.readBy ?? []), name]
          else message.read = true
          counts.set(key, remaining - 1)
          updated[index] = JSON.stringify(message)
          changed = true
        }
        if (!changed) continue
        const remainder = Buffer.from(bytes.subarray(completeEnd))
        const content = Buffer.concat([Buffer.from(updated.join('\n') + '\n'), remainder])
        atomicWriteFile(file, content)
        const refreshedMessages = parsedLines.filter((message): message is StoredMailMessage => message !== null)
        let refreshedSorted = true
        for (let index = 1; index < refreshedMessages.length; index++) {
          if (refreshedMessages[index - 1].ts > refreshedMessages[index].ts) {
            refreshedSorted = false
            break
          }
        }
        if (!refreshedSorted) refreshedMessages.sort(compareMailMessages)
        const after = statSync(file)
        this.fileCache.set(file, {
          size: content.length,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          birthtimeMs: after.birthtimeMs,
          ino: after.ino,
          messages: refreshedMessages,
          remainder,
          tail: Buffer.from(content.subarray(Math.max(0, content.length - CACHE_TAIL_BYTES))),
        })
      }
    })
  }

  // 协议消息解析：首行 APPROVE/DENY/PROTO
  static parseProtocol(body: string): { type: 'APPROVE' | 'DENY' | 'PROTO' | 'PLAN' | 'ASSIGN' | 'IDLE' | 'TEXT'; rest: string } {
    const prefix = body.split('\n')[0].match(/^\s*([A-Za-z]+)(?=\s|[:：]|$)/)
    if (!prefix) return { type: 'TEXT', rest: body }
    const upper = prefix[1].toUpperCase()
    for (const t of ['APPROVE', 'DENY', 'PROTO', 'PLAN', 'ASSIGN', 'IDLE'] as const) {
      if (upper === t) return { type: t, rest: body.slice(prefix[0].length).replace(/^[^\S\r\n]*[:：]/, '').trim() }
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
