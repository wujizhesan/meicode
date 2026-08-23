import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

export class SubAgentStore {
  private readonly file: string

  constructor(root: string, sessionId: string) {
    mkdirSync(root, { recursive: true })
    this.file = join(root, `${safeSessionId(sessionId)}.json`)
  }

  load(): SubAgentRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) return parsed.filter(isRecord)
      this.quarantineCorrupt()
      return []
    } catch {
      this.quarantineCorrupt()
      return []
    }
  }

  private quarantineCorrupt(): void {
    const backup = `${this.file}.corrupt.${Date.now()}.json`
    try {
      renameSync(this.file, backup)
    } catch {
    }
  }

  save(record: SubAgentRecord): void {
    withLock(`${this.file}.lock`, () => {
      const records = this.load().filter((item) => item.id !== record.id)
      records.push(record)
      const temp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      const content = JSON.stringify(records, null, 2)
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
    })
  }
}
