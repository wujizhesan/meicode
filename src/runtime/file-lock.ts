import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_TTL_MS = 30000
const DEFAULT_TIMEOUT_MS = 5000
const MAX_RETRY_DELAY_MS = 100
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4))

interface Ticket {
  name: string
  order: number | null
  choosing: boolean
}

export interface FileLockLease {
  ticketFile: string
  queueDir: string
  ownerContent?: string
}

function sleepSync(ms: number): void {
  Atomics.wait(WAIT_ARRAY, 0, 0, ms)
}

function legacyTimestamp(file: string): number | null {
  try {
    const content = readFileSync(file, 'utf8')
    const legacy = Number(content)
    if (Number.isFinite(legacy) && legacy > 0) return legacy
    const value = JSON.parse(content) as { ts?: unknown }
    if (typeof value.ts === 'number' && Number.isFinite(value.ts) && value.ts > 0) return value.ts
  } catch {
  }
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

function clearStaleLegacyLock(file: string, ttlMs: number): boolean {
  let before: ReturnType<typeof statSync>
  try {
    before = statSync(file)
  } catch {
    return true
  }
  const ts = legacyTimestamp(file)
  if (ts === null || Date.now() - ts <= ttlMs) return false
  try {
    const current = statSync(file)
    if (current.dev !== before.dev || current.ino !== before.ino || current.birthtimeMs !== before.birthtimeMs) return false
    rmSync(file, { force: true })
    return true
  } catch {
    return !existsSync(file)
  }
}

/**
 * 并发持有者清理队列时，建目录、写锁文件、开票据都可能撞上「路径正在消失 / 句柄未释放」
 * 的中间态：POSIX 报 ENOENT，Windows 还会报 EPERM / EBUSY。这些都不是权限问题，
 * 而是瞬时竞态——调用方有 deadline 兜底，重试到预算耗尽仍失败才算真失败。
 */
function isRetryableFsRace(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * 写锁文件/开票据时的重试判据，比 isRetryableFsRace 窄：EACCES 是真权限问题（只读目录、
 * ACL 拒绝），重试到 deadline 也没用，必须如实失败；EPERM/EBUSY 在 Windows 上更多是
 * 「同名路径正在被删除/释放」的瞬时状态，值得重试。
 */
function isTransientLockError(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'EPERM' || code === 'EBUSY'
}

function readTickets(queueDir: string, ttlMs: number): Ticket[] {
  const now = Date.now()
  const tickets: Ticket[] = []
  let names: string[]
  try {
    names = readdirSync(queueDir)
  } catch {
    return tickets
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(queueDir, name)
    let ts = 0
    let order: number | null = null
    let choosing = true
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { ts?: unknown; order?: unknown; choosing?: unknown }
      if (typeof value.ts === 'number' && Number.isFinite(value.ts)) ts = value.ts
      if (typeof value.order === 'number' && Number.isSafeInteger(value.order) && value.order > 0) order = value.order
      choosing = value.choosing !== false || order === null
    } catch {
    }
    if (ts <= 0) {
      try {
        ts = statSync(file).mtimeMs
      } catch {
        continue
      }
    }
    if (now - ts > ttlMs) {
      try {
        rmSync(file, { force: true })
      } catch {
      }
      continue
    }
    tickets.push({ name, order, choosing })
  }
  return tickets
}

export function acquireFileLock(
  lockFile: string,
  options: { ttlMs?: number; timeoutMs?: number } = {},
): FileLockLease {
  const ttlMs = Math.max(1000, options.ttlMs ?? DEFAULT_TTL_MS)
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let deadline = Date.now() + timeoutMs
  // 排队等待的预算允许因「队列仍在前进」而续期，但总等待有硬上限：
  // 卡死的票据最迟在 TTL 后被清理，等待不可能、也不应该超过 ttlMs + timeoutMs。
  const hardDeadline = Date.now() + ttlMs + timeoutMs
  const queueDir = `${lockFile}.queue`
  const owner = `${process.pid}-${randomUUID()}`
  let ticketFile = ''
  let retryDelay = 2

  if (!existsSync(queueDir)) {
    mkdirSync(dirname(lockFile), { recursive: true })
    const ownerContent = JSON.stringify({ owner, ts: Date.now() })
    try {
      writeFileSync(lockFile, ownerContent, { flag: 'wx' })
      const lease = { ticketFile: lockFile, queueDir, ownerContent }
      if (!existsSync(queueDir)) return lease
      releaseFileLock(lease)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && !isTransientLockError(code)) throw error
    }
  }

  while (Date.now() < deadline) {
    try {
      mkdirSync(queueDir, { recursive: true })
    } catch (error) {
      // 队列目录可能被并发持有者刚刚清理：Windows 上递归 mkdir 撞上"目录正在消失"
      // 的中间态会报 ENOENT，目录句柄尚未完全释放时还会报 EPERM/EBUSY
      // （CI 上多进程锁竞争实测）。这类错误都是「此刻的竞态」而非权限问题——
      // 重试有 deadline 兜底，真没权限也会在预算耗尽后如实失败。
      if (!isRetryableFsRace((error as NodeJS.ErrnoException).code)) throw error
      sleepSync(Math.min(retryDelay, Math.max(1, deadline - Date.now())))
      retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2)
      continue
    }
    if (existsSync(lockFile) && !clearStaleLegacyLock(lockFile, ttlMs)) {
      sleepSync(Math.min(retryDelay, Math.max(1, deadline - Date.now())))
      retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2)
      continue
    }
    ticketFile = join(queueDir, `${owner}.json`)
    try {
      const fd = openSync(ticketFile, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ owner, choosing: true, ts: Date.now() }), 'utf8')
      } finally {
        closeSync(fd)
      }
      const maxOrder = readTickets(queueDir, ttlMs).reduce((max, ticket) => Math.max(max, ticket.order ?? 0), 0)
      writeFileSync(ticketFile, JSON.stringify({ owner, choosing: false, order: maxOrder + 1, ts: Date.now() }), 'utf8')
      break
    } catch (error) {
      try {
        if (ticketFile) rmSync(ticketFile, { force: true })
      } catch {
      }
      const ticketCode = (error as NodeJS.ErrnoException).code
      if (ticketCode !== 'EEXIST' && !isTransientLockError(ticketCode)) throw error
      ticketFile = ''
    }
  }

  if (!ticketFile) {
    try { rmdirSync(queueDir) } catch { }
    throw new Error(`无法获取锁: ${lockFile}（${timeoutMs}ms 内锁文件未被释放，持有者可能已卡死）`)
  }
  retryDelay = 2
  // timeoutMs 的语义是「队列静止多久才放弃」，不是「总共最多等多久」：
  // 只要窗口内还有人在释放（队首易人、票据减少），就把预算续到「现在 + timeoutMs」。
  // 慢磁盘上 N 个进程串行持锁时总排队时间可能远超单次预算，但每次交接都是进展，
  // 此时等待是正确行为；真正要快速失败的是持有者卡死且队列完全静止的情况。
  let lastActivityKey = ''
  let lastTickets: Ticket[] = []
  let ownOrder: number | null = null
  let ownLost = false
  while (Date.now() < deadline) {
    const tickets = readTickets(queueDir, ttlMs)
    const own = tickets.find((ticket) => ticket.name === `${owner}.json`)
    if (!own) { ownLost = true; break }
    lastTickets = tickets
    ownOrder = own.order
    const activityKey = tickets
      .filter((ticket) => ticket.name !== own.name)
      .map((ticket) => `${ticket.name}:${ticket.choosing ? 'c' : ticket.order ?? '?'}`)
      .sort()
      .join('|')
    if (activityKey !== lastActivityKey) {
      lastActivityKey = activityKey
      deadline = Math.min(Date.now() + timeoutMs, hardDeadline)
    }
    const choosing = tickets.some((ticket) => ticket.name !== own.name && ticket.choosing)
    const ordered = tickets
      .filter((ticket): ticket is Ticket & { order: number } => !ticket.choosing && ticket.order !== null)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    if (!choosing && ordered[0]?.name === own.name) return { ticketFile, queueDir }
    sleepSync(Math.min(retryDelay, Math.max(1, deadline - Date.now())))
    retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2)
  }

  releaseFileLock({ ticketFile, queueDir })
  if (ownLost) {
    throw new Error(`无法获取锁: ${lockFile}（排队超过 TTL ${ttlMs}ms，票据已被清理，队列仍有 ${lastTickets.length} 个成员）`)
  }
  const ahead = lastTickets.filter(
    (ticket) => ticket.choosing || (ownOrder !== null && ticket.order !== null && ticket.order < ownOrder),
  ).length
  throw new Error(
    ahead > 0
      ? `无法获取锁: ${lockFile}（${timeoutMs}ms 内队列无进展，前方仍有 ${ahead} 个持有者未释放）`
      : `无法获取锁: ${lockFile}（${timeoutMs}ms 内未取得锁且队列无进展）`,
  )
}

export function releaseFileLock(lease: FileLockLease): void {
  if (lease.ownerContent !== undefined) {
    try {
      if (readFileSync(lease.ticketFile, 'utf8') === lease.ownerContent) rmSync(lease.ticketFile, { force: true })
    } catch { }
    return
  }
  try {
    rmSync(lease.ticketFile, { force: true })
  } catch {
  }
  try {
    rmdirSync(lease.queueDir)
  } catch {
  }
}

export function withFileLock<T>(lockFile: string, fn: () => T, options?: { ttlMs?: number; timeoutMs?: number }): T {
  const lease = acquireFileLock(lockFile, options)
  try {
    return fn()
  } finally {
    releaseFileLock(lease)
  }
}
