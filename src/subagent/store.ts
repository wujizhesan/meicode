import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SubAgentRecord } from './types.ts'
import { withLock } from '../team/lock.ts'

const STATUS = new Set(['created', 'running', 'done', 'error', 'cancelled', 'timed_out'])

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
    } catch {
      this.cache = undefined
      return []
    }
    if (this.cache && this.cache.size === stats.size && this.cache.mtimeMs === stats.mtimeMs && this.cache.ctimeMs === stats.ctimeMs && this.cache.ino === stats.ino) {
      return this.cache.records
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) {
        if (!parsed.every(isRecord)) {
          this.quarantineCorrupt()
          return []
        }
        const records = parsed
        this.cache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, records }
        return records
      }
      this.quarantineCorrupt()
      return []
    } catch {
      this.quarantineCorrupt()
      return []
    }
  }

  private quarantineCorrupt(): void {
    this.cache = undefined
    const backup = `${this.file}.corrupt.${Date.now()}.json`
    try {
      renameSync(this.file, backup)
    } catch {
    }
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
    const temp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    const content = JSON.stringify(records)
    try {
      writeFileSync(temp, content, 'utf8')
      try {
        renameSync(temp, this.file)
      } catch {
        writeFileSync(this.file, content, 'utf8')
        rmSync(temp, { force: true })
      }
    } catch (error) {
      rmSync(temp, { force: true })
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
      if (current.ownerId !== ownerId || (current.status !== 'created' && current.status !== 'running')) return
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
      if (current.status !== 'created' && current.status !== 'running') {
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
      if (current.status !== 'created' && current.status !== 'running') {
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
      if (current.status !== 'created' && current.status !== 'running') {
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
