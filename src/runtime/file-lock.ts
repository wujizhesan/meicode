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
  const deadline = Date.now() + timeoutMs
  const queueDir = `${lockFile}.queue`
  const owner = `${process.pid}-${randomUUID()}`
  let ticketFile = ''
  let retryDelay = 2

  while (Date.now() < deadline) {
    if (existsSync(lockFile) && !clearStaleLegacyLock(lockFile, ttlMs)) {
      sleepSync(Math.min(retryDelay, Math.max(1, deadline - Date.now())))
      retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2)
      continue
    }
    mkdirSync(dirname(lockFile), { recursive: true })
    mkdirSync(queueDir, { recursive: true })
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ticketFile = ''
    }
  }

  if (!ticketFile) throw new Error(`无法获取锁: ${lockFile}`)
  retryDelay = 2
  while (Date.now() < deadline) {
    const tickets = readTickets(queueDir, ttlMs)
    const own = tickets.find((ticket) => ticket.name === `${owner}.json`)
    if (!own) break
    const choosing = tickets.some((ticket) => ticket.name !== own.name && ticket.choosing)
    const ordered = tickets
      .filter((ticket): ticket is Ticket & { order: number } => !ticket.choosing && ticket.order !== null)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    if (!choosing && ordered[0]?.name === own.name) return { ticketFile, queueDir }
    sleepSync(Math.min(retryDelay, Math.max(1, deadline - Date.now())))
    retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2)
  }

  releaseFileLock({ ticketFile, queueDir })
  throw new Error(`无法获取锁: ${lockFile}`)
}

export function releaseFileLock(lease: FileLockLease): void {
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
