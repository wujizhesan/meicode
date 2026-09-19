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
  return typeof record.id === 'string'
    && typeof record.role === 'string'
    && (record.type === 'defined' || record.type === 'fork')
    && typeof record.status === 'string'
    && STATUS.has(record.status)
    && Number.isFinite(record.startedAt)
}

interface CachedSubAgentStore {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  records: SubAgentRecord[]
}

export class SubAgentStore {
  private readonly file: string
  private cache?: CachedSubAgentStore

  constructor(root: string, sessionId: string) {
    this.file = join(root, `${safeSessionId(sessionId)}.json`)
  }

  load(): SubAgentRecord[] {
    return structuredClone(this.loadInternal())
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
        const records = parsed.filter(isRecord)
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

  save(record: SubAgentRecord): void {
    mkdirSync(dirname(this.file), { recursive: true })
    withLock(`${this.file}.lock`, () => {
      const records = this.loadInternal().filter((item) => item.id !== record.id)
      records.push(structuredClone(record))
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
    })
  }
}
