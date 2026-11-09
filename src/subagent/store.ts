import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SubAgentRecord } from './types.ts'
import { isActiveSubAgentStatus } from './types.ts'
import { withLock } from '../team/lock.ts'
import { writeTextAtomicSync } from '../tools/atomic-write.ts'

const STATUS = new Set(['created', 'running', 'saving', 'done', 'error', 'cancelled', 'timed_out'])

function safeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')
  if (safe === sessionId) return safe
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return `${safe || 'session'}-${hash}`
}

function isRecord(value: unknown): value is SubAgentRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<SubAgentRecord>
  if (!(typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.role === 'string'
    && record.role.length > 0
    && (record.type === 'defined' || record.type === 'fork')
    && typeof record.status === 'string'
    && STATUS.has(record.status)
    && typeof record.startedAt === 'number'
    && Number.isFinite(record.startedAt)
    && record.startedAt >= 0)) return false
  for (const key of ['sessionId', 'parentAgentId', 'taskId', 'reportId', 'result', 'error', 'ownerId', 'cancelReason'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') return false
  }
  for (const key of ['updatedAt', 'finishedAt', 'leaseExpiresAt', 'cancelRequestedAt', 'tokens'] as const) {
    const current = record[key]
    if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current) || current < 0)) return false
  }
  if (record.evidence !== undefined) {
    if (!record.evidence || typeof record.evidence !== 'object' || Array.isArray(record.evidence)) return false
    const evidence = record.evidence as unknown as Record<string, unknown>
    for (const key of ['files', 'commands', 'artifacts', 'changedFiles'] as const) {
      if (!Array.isArray(evidence[key]) || !(evidence[key] as unknown[]).every((item) => typeof item === 'string')) return false
    }
    if (!Array.isArray(evidence.tests) || !evidence.tests.every((test) => {
      if (!test || typeof test !== 'object' || Array.isArray(test)) return false
      const item = test as Record<string, unknown>
      return typeof item.command === 'string'
        && typeof item.passed === 'boolean'
        && (item.output === undefined || typeof item.output === 'string')
    })) return false
  }
  return true
}

interface CachedSubAgentStore {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  records: SubAgentRecord[]
}

export interface PendingSubAgentTerminal {
  ownerId: string
  record: SubAgentRecord
}

export class SubAgentStore {
  private readonly root: string
  private readonly sessionId: string
  private readonly file: string
  private cache?: CachedSubAgentStore

  constructor(root: string, sessionId: string) {
    this.root = root
    this.sessionId = sessionId
    this.file = join(root, `${safeSessionId(sessionId)}.json`)
  }

  getSessionId(): string {
    return this.sessionId
  }

  forSession(sessionId: string): SubAgentStore {
    return sessionId === this.sessionId ? this : new SubAgentStore(this.root, sessionId)
  }

  private pendingFile(id: string, ownerId: string): string {
    const key = createHash('sha256').update(JSON.stringify([id, ownerId])).digest('hex')
    return join(`${this.file}.pending`, `${key}.json`)
  }

  savePendingTerminal(record: SubAgentRecord, ownerId: string): void {
    if (!isRecord(record) || isActiveSubAgentStatus(record.status) || !ownerId || (record.sessionId !== undefined && record.sessionId !== this.sessionId)) {
      throw new Error('非法子 Agent 补存记录')
    }
    const file = this.pendingFile(record.id, ownerId)
    mkdirSync(dirname(file), { recursive: true })
    const destination = join(realpathSync.native(dirname(file)), basename(file))
    writeTextAtomicSync(destination, JSON.stringify({ ownerId, record }), { cwd: this.root })
  }

  loadPendingTerminals(): PendingSubAgentTerminal[] {
    const directory = `${this.file}.pending`
    let names: string[]
    try { names = readdirSync(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const pending: PendingSubAgentTerminal[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(directory, name)
      let raw: string
      try { raw = readFileSync(file, 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      let value: Partial<PendingSubAgentTerminal> | undefined
      try { value = JSON.parse(raw) }
      catch { }
      if (!value || typeof value.ownerId !== 'string' || !value.ownerId
        || !isRecord(value.record) || isActiveSubAgentStatus(value.record.status)
        || (value.record.sessionId !== undefined && value.record.sessionId !== this.sessionId) || this.pendingFile(value.record.id, value.ownerId) !== file) {
        renameSync(file, `${file}.corrupt.${Date.now()}`)
        continue
      }
      pending.push({ ownerId: value.ownerId, record: value.record })
    }
    return pending
  }

  deletePendingTerminal(id: string, ownerId: string): void {
    try { unlinkSync(this.pendingFile(id, ownerId)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  load(): SubAgentRecord[] {
    return structuredClone(this.loadInternal())
  }

  get(id: string): SubAgentRecord | null {
    const record = this.loadInternal().find((current) => current.id === id)
    return record ? structuredClone(record) : null
  }

  private loadInternal(): SubAgentRecord[] {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(this.file)
    } catch (error) {
      this.cache = undefined
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (this.cache && this.cache.size === stats.size && this.cache.mtimeMs === stats.mtimeMs && this.cache.ctimeMs === stats.ctimeMs && this.cache.ino === stats.ino) {
      return this.cache.records
    }
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      this.cache = undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.quarantineCorrupt()
      return []
    }
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      this.quarantineCorrupt()
      return []
    }
    const records = parsed
    this.cache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, records }
    return records
  }

  private quarantineCorrupt(): void {
    this.cache = undefined
    const backup = `${this.file}.corrupt.${Date.now()}.json`
    renameSync(this.file, backup)
  }

  private updateCache(records: SubAgentRecord[]): void {
    try {
      const stats = statSync(this.file)
      this.cache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, records }
    } catch {
      this.cache = undefined
    }
  }

  private writeRecords(records: SubAgentRecord[]): void {
    try {
      const destination = join(realpathSync.native(dirname(this.file)), basename(this.file))
      writeTextAtomicSync(destination, JSON.stringify(records), { cwd: this.root })
    } catch (error) {
      this.cache = undefined
      throw error
    }
    this.updateCache(records)
  }

  save(record: SubAgentRecord, expectedOwnerId?: string): boolean {
    if (!isRecord(record)) throw new Error('非法子 Agent 记录')
    mkdirSync(dirname(this.file), { recursive: true })
    let saved = false
    withLock(`${this.file}.lock`, () => {
      const current = this.loadInternal()
      const existing = current.find((item) => item.id === record.id)
      if (expectedOwnerId !== undefined && existing?.ownerId !== expectedOwnerId) return
      if (expectedOwnerId !== undefined && existing?.cancelRequestedAt !== undefined) {
        record.status = 'cancelled'
        record.error = existing.cancelReason ?? '用户取消'
        record.cancelRequestedAt = existing.cancelRequestedAt
        record.cancelReason = existing.cancelReason
        record.finishedAt ??= Date.now()
        delete record.ownerId
        delete record.leaseExpiresAt
      }
      const records = current.filter((item) => item.id !== record.id)
      records.push(structuredClone(record))
      this.writeRecords(records)
      saved = true
    })
    return saved
  }

  renewLease(id: string, ownerId: string, leaseExpiresAt: number): SubAgentRecord | null {
    let renewed: SubAgentRecord | null = null
    withLock(`${this.file}.lock`, () => {
      const records = this.loadInternal()
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return
      const current = records[index]
      if (current.ownerId !== ownerId || !isActiveSubAgentStatus(current.status)) return
      records[index] = { ...current, leaseExpiresAt, updatedAt: Date.now() }
      this.writeRecords(records)
      renewed = structuredClone(records[index])
    })
    return renewed
  }

  requestCancel(id: string, reason = '用户取消', now = Date.now()): SubAgentRecord | null {
    let requested: SubAgentRecord | null = null
    withLock(`${this.file}.lock`, () => {
      const records = this.loadInternal()
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return
      const current = records[index]
      if (!isActiveSubAgentStatus(current.status)) {
        requested = structuredClone(current)
        return
      }
      const next: SubAgentRecord = {
        ...current,
        cancelRequestedAt: current.cancelRequestedAt ?? now,
        cancelReason: current.cancelReason ?? reason,
        updatedAt: now,
      }
      if ((current.leaseExpiresAt ?? 0) <= now) {
        next.status = 'cancelled'
        next.error = next.cancelReason
        next.finishedAt = now
        delete next.ownerId
        delete next.leaseExpiresAt
      }
      records[index] = next
      this.writeRecords(records)
      requested = structuredClone(next)
    })
    return requested
  }

  cancelOwned(id: string, ownerId: string, reason = 'SubAgentManager 关闭，子 Agent 已取消'): SubAgentRecord | null {
    let cancelled: SubAgentRecord | null = null
    withLock(`${this.file}.lock`, () => {
      const records = this.loadInternal()
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return
      const current = records[index]
      if (!isActiveSubAgentStatus(current.status)) {
        cancelled = structuredClone(current)
        return
      }
      if (current.ownerId !== ownerId) return
      const now = Date.now()
      const next: SubAgentRecord = {
        ...current,
        status: 'cancelled',
        error: reason,
        cancelRequestedAt: current.cancelRequestedAt ?? now,
        cancelReason: current.cancelReason ?? reason,
        finishedAt: now,
        updatedAt: now,
      }
      delete next.ownerId
      delete next.leaseExpiresAt
      records[index] = next
      this.writeRecords(records)
      cancelled = structuredClone(next)
    })
    return cancelled
  }

  reclaimExpired(id: string, now = Date.now()): SubAgentRecord | null {
    let reclaimed: SubAgentRecord | null = null
    withLock(`${this.file}.lock`, () => {
      const records = this.loadInternal()
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return
      const current = records[index]
      if (!isActiveSubAgentStatus(current.status)) {
        reclaimed = structuredClone(current)
        return
      }
      if ((current.leaseExpiresAt ?? 0) > now) {
        reclaimed = structuredClone(current)
        return
      }
      const next: SubAgentRecord = {
        ...current,
        status: current.cancelRequestedAt === undefined ? 'error' : 'cancelled',
        error: current.cancelRequestedAt === undefined
          ? '进程退出或租约过期，子 Agent 已中断'
          : current.cancelReason ?? '用户取消',
        finishedAt: now,
        updatedAt: now,
      }
      delete next.ownerId
      delete next.leaseExpiresAt
      records[index] = next
      this.writeRecords(records)
      reclaimed = structuredClone(next)
    })
    return reclaimed
  }
}
