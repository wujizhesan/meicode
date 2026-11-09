import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { atomicWriteFile } from '../team/atomic.ts'
import { withLock } from '../team/lock.ts'
import { isObject, TASK_STATES, TERMINAL_STATES } from './protocol.ts'
import type { A2APushNotificationConfig, A2APushOutboxEntry, A2AStoredTask, A2ATask, TaskState } from './types.ts'

export interface A2aTaskMetadata {
  id: string
  contextId: string
  state: TaskState
  timestamp: string
  messageIds: string[]
  pendingPushDeliveries: number
}

interface StoredTaskMetadata {
  metadata: A2aTaskMetadata
  fingerprint: { size: number; mtimeMs: number; ctimeMs: number; ino: number }
}

interface MetadataIndex {
  version: 1 | 2
  count: number
  entries: Record<string, unknown>
  journalId?: string
}

interface MetadataJournal {
  id: string
  operations: MetadataOperation[]
}

type MetadataOperation = { op: 'set'; name: string; entry: StoredTaskMetadata } | { op: 'delete'; name: string }

const RECORD_NAME = /^[a-f0-9]{64}\.json$/
const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024

export function metadataForTask(task: A2ATask, pendingPushDeliveries: number): A2aTaskMetadata {
  return {
    id: task.id,
    contextId: task.contextId,
    state: task.status.state,
    timestamp: task.status.timestamp,
    messageIds: task.history.map((message) => message.messageId).filter((id): id is string => typeof id === 'string'),
    pendingPushDeliveries,
  }
}

function isStoredTaskMetadata(value: unknown): value is StoredTaskMetadata {
  if (!isObject(value) || !isObject(value.metadata) || !isObject(value.fingerprint)) return false
  const metadata = value.metadata
  const fingerprint = value.fingerprint
  return typeof metadata.id === 'string'
    && typeof metadata.contextId === 'string'
    && typeof metadata.state === 'string'
    && TASK_STATES.has(metadata.state as TaskState)
    && typeof metadata.timestamp === 'string'
    && Array.isArray(metadata.messageIds)
    && metadata.messageIds.every((id) => typeof id === 'string')
    && Number.isSafeInteger(metadata.pendingPushDeliveries)
    && Number(metadata.pendingPushDeliveries) >= 0
    && ['size', 'mtimeMs', 'ctimeMs', 'ino'].every((key) => Number.isFinite(fingerprint[key]))
}

function isMetadataOperation(value: unknown): value is MetadataOperation {
  if (!isObject(value) || typeof value.name !== 'string' || !RECORD_NAME.test(value.name)) return false
  if (value.op === 'delete') return true
  if (value.op !== 'set' || !isStoredTaskMetadata(value.entry)) return false
  return createHash('sha256').update(value.entry.metadata.id).digest('hex') + '.json' === value.name
}

function applyMetadataOperations(entries: Record<string, unknown>, operations: MetadataOperation[]): void {
  for (const operation of operations) {
    if (operation.op === 'set') entries[operation.name] = operation.entry
    else delete entries[operation.name]
  }
}

function isPersistedTask(value: unknown): value is A2ATask {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.contextId !== 'string') return false
  if (!isObject(value.status) || typeof value.status.timestamp !== 'string' || typeof value.status.state !== 'string') return false
  if (!TASK_STATES.has(value.status.state as TaskState)) return false
  return Array.isArray(value.history) && Array.isArray(value.artifacts)
}

function isPushNotificationConfig(value: unknown): value is A2APushNotificationConfig {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.taskId !== 'string' || typeof value.url !== 'string') return false
  if (value.token !== undefined && typeof value.token !== 'string') return false
  return value.authentication === undefined || (
    isObject(value.authentication)
    && typeof value.authentication.scheme === 'string'
    && typeof value.authentication.credentials === 'string'
  )
}

function isPushOutboxEntry(value: unknown): value is A2APushOutboxEntry {
  if (!isObject(value) || typeof value.deliveryId !== 'string' || !value.deliveryId || !isPushNotificationConfig(value.config)) return false
  if (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0 || !Number.isFinite(value.nextAttemptAt) || Number(value.nextAttemptAt) < 0) return false
  if (!isObject(value.event)) return false
  if (value.event.kind === 'artifact') {
    return typeof value.event.artifactId === 'string' && !!value.event.artifactId && typeof value.event.append === 'boolean' && typeof value.event.lastChunk === 'boolean'
  }
  return value.event.kind === 'terminal'
    && isObject(value.event.status)
    && typeof value.event.status.timestamp === 'string'
    && typeof value.event.status.state === 'string'
    && TASK_STATES.has(value.event.status.state as TaskState)
}

function parseStoredTask(value: unknown): A2AStoredTask | undefined {
  if (isPersistedTask(value)) return { task: value, pushNotificationConfigs: [], pendingPushDeliveries: [] }
  if (!isObject(value)) return undefined
  const task = value.task
  if (!isPersistedTask(task)) return undefined
  const configs = Array.isArray(value.pushNotificationConfigs)
    ? value.pushNotificationConfigs.filter(isPushNotificationConfig)
    : []
  const pendingPushDeliveries = Array.isArray(value.pendingPushDeliveries)
    ? value.pendingPushDeliveries.filter(isPushOutboxEntry).filter((entry) => entry.config.taskId === task.id)
    : []
  return { task, pushNotificationConfigs: configs, pendingPushDeliveries }
}

function quarantine(file: string): void {
  try {
    renameSync(file, `${file}.corrupt.${Date.now()}.${randomUUID()}.json`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class A2aTaskStore {
  private readonly legacyFile: string
  private readonly recordsDir: string
  private readonly migrationMarker: string
  private readonly metadataIndexFile: string
  private readonly metadataJournalFile: string
  private readonly metadataJournalLock: string
  private journalWrites = 0

  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.legacyFile = join(root, 'tasks.json')
    this.recordsDir = join(root, 'records')
    this.migrationMarker = join(root, 'records.ready')
    this.metadataIndexFile = join(root, 'metadata-index.json')
    this.metadataJournalFile = join(root, 'metadata-journal.jsonl')
    this.metadataJournalLock = join(root, 'metadata-journal.lock')
  }

  private recordFile(taskId: string): string {
    const key = createHash('sha256').update(taskId).digest('hex')
    return join(this.recordsDir, `${key}.json`)
  }

  private metadataFile(taskId: string): string {
    return this.recordFile(taskId).replace(/\.json$/, '.meta.json')
  }

  private readRecordFile(file: string): A2AStoredTask {
    const stored = parseStoredTask(JSON.parse(readFileSync(file, 'utf8')))
    if (!stored || this.recordFile(stored.task.id) !== file) throw new Error('invalid task record')
    return stored
  }

  private writeMetadata(file: string, stored: A2AStoredTask): StoredTaskMetadata {
    const stats = statSync(file)
    const metadata = metadataForTask(stored.task, stored.pendingPushDeliveries.length)
    const fingerprint = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino }
    const entry = { metadata, fingerprint }
    atomicWriteFile(file.replace(/\.json$/, '.meta.json'), JSON.stringify(entry))
    return entry
  }

  private currentMetadata(value: unknown, file: string, stats: NonNullable<ReturnType<typeof statSync>>): StoredTaskMetadata | undefined {
    if (!isStoredTaskMetadata(value) || this.recordFile(value.metadata.id) !== file) return undefined
    const fingerprint = value.fingerprint
    return fingerprint.size === stats.size
      && fingerprint.mtimeMs === stats.mtimeMs
      && fingerprint.ctimeMs === stats.ctimeMs
      && fingerprint.ino === stats.ino ? value : undefined
  }

  private readMetadataIndex(): MetadataIndex | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.metadataIndexFile, 'utf8'))
      if (!isObject(value) || (value.version !== 1 && value.version !== 2)
        || !Number.isSafeInteger(value.count) || !isObject(value.entries)) return undefined
      if (value.version === 2 && (typeof value.journalId !== 'string' || !value.journalId)) return undefined
      return { version: value.version, count: Number(value.count), entries: value.entries, journalId: value.version === 2 ? value.journalId as string : undefined }
    } catch {
      return undefined
    }
  }

  private readMetadataJournal(): MetadataJournal | undefined {
    let content: string
    try {
      content = readFileSync(this.metadataJournalFile, 'utf8')
    } catch {
      return undefined
    }
    if (!content.endsWith('\n')) return undefined
    try {
      const lines = content.slice(0, -1).split('\n')
      const header: unknown = JSON.parse(lines.shift() ?? '')
      if (!isObject(header) || header.version !== 1 || typeof header.id !== 'string' || !header.id) return undefined
      const operations: MetadataOperation[] = []
      for (const line of lines) {
        const operation: unknown = JSON.parse(line)
        if (!isMetadataOperation(operation)) return undefined
        operations.push(operation)
      }
      return { id: header.id, operations }
    } catch {
      return undefined
    }
  }

  private readMetadataCache(): { index?: MetadataIndex; journal?: MetadataJournal; entries: Record<string, unknown>; valid: boolean } {
    const index = this.readMetadataIndex()
    const journal = this.readMetadataJournal()
    const valid = index?.version !== 2 || index.journalId === journal?.id
    const entries: Record<string, unknown> = Object.assign(Object.create(null), index?.entries)
    if (valid && journal) applyMetadataOperations(entries, journal.operations)
    return { index, journal, entries, valid }
  }

  private writeMetadataSnapshot(entries: Record<string, unknown>): void {
    const journalId = randomUUID()
    atomicWriteFile(this.metadataIndexFile, JSON.stringify({ version: 2, count: Object.keys(entries).length, entries, journalId }))
    atomicWriteFile(this.metadataJournalFile, JSON.stringify({ version: 1, id: journalId }) + '\n')
  }

  private compactMetadataJournal(): void {
    const cache = this.readMetadataCache()
    if (!cache.index || !cache.journal || !cache.valid) return
    this.writeMetadataSnapshot(cache.entries)
  }

  private appendMetadataOperation(operation: MetadataOperation): void {
    try {
      if (!existsSync(this.metadataJournalFile)) {
        try {
          writeFileSync(this.metadataJournalFile, JSON.stringify({ version: 1, id: randomUUID() }) + '\n', { flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      appendFileSync(this.metadataJournalFile, JSON.stringify(operation) + '\n')
      if (++this.journalWrites % 256 === 0 && statSync(this.metadataJournalFile).size >= JOURNAL_COMPACT_BYTES) {
        withLock(this.metadataJournalLock, () => this.compactMetadataJournal())
      }
    } catch { }
  }

  private readLegacy(): A2AStoredTask[] {
    let content: string
    try {
      content = readFileSync(this.legacyFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(content)
      if (!Array.isArray(parsed)) throw new Error('invalid task store')
      return parsed.flatMap((value): A2AStoredTask[] => {
        const stored = parseStoredTask(value)
        return stored ? [stored] : []
      })
    } catch {
      quarantine(this.legacyFile)
      return []
    }
  }

  private ensureMigrated(): void {
    if (existsSync(this.migrationMarker)) return
    withLock(`${this.legacyFile}.lock`, () => {
      if (existsSync(this.migrationMarker)) return
      mkdirSync(this.recordsDir, { recursive: true })
      for (const stored of this.readLegacy()) {
        const file = this.recordFile(stored.task.id)
        atomicWriteFile(file, JSON.stringify(stored))
      }
      atomicWriteFile(this.migrationMarker, '1')
    })
  }

  load(): A2AStoredTask[] {
    this.ensureMigrated()
    const tasks: A2AStoredTask[] = []
    for (const name of readdirSync(this.recordsDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const file = join(this.recordsDir, name)
      try {
        tasks.push(this.readRecordFile(file))
      } catch {
        quarantine(file)
      }
    }
    return tasks
  }

  loadMetadata(): A2aTaskMetadata[] {
    this.ensureMigrated()
    const metadata: A2aTaskMetadata[] = []
    let cache!: ReturnType<A2aTaskStore['readMetadataCache']>
    withLock(this.metadataJournalLock, () => { cache = this.readMetadataCache() })
    const entries: Record<string, StoredTaskMetadata> = Object.create(null)
    let indexDirty = !cache.index || !cache.valid
    for (const name of readdirSync(this.recordsDir)) {
      if (!RECORD_NAME.test(name)) continue
      const file = join(this.recordsDir, name)
      const metadataFile = file.replace(/\.json$/, '.meta.json')
      try {
        const stats = statSync(file)
        const cached = this.currentMetadata(cache.valid ? cache.entries[name] : undefined, file, stats)
        if (cached) {
          if (!TERMINAL_STATES.has(cached.metadata.state) && !existsSync(metadataFile)) {
            try { atomicWriteFile(metadataFile, JSON.stringify(cached)) } catch { }
          }
          entries[name] = cached
          metadata.push(cached.metadata)
          continue
        }
        indexDirty = true
        const parsed = this.currentMetadata(JSON.parse(readFileSync(metadataFile, 'utf8')), file, stats)
        if (parsed) {
          entries[name] = parsed
          metadata.push(parsed.metadata)
          continue
        }
      } catch { }
      try {
        let rebuilt: StoredTaskMetadata | undefined
        withLock(`${file}.lock`, () => {
          const stored = this.readRecordFile(file)
          try {
            rebuilt = this.writeMetadata(file, stored)
          } catch {
            const stats = statSync(file)
            rebuilt = {
              metadata: metadataForTask(stored.task, stored.pendingPushDeliveries.length),
              fingerprint: { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino },
            }
          }
        })
        if (rebuilt) {
          entries[name] = rebuilt
          metadata.push(rebuilt.metadata)
          indexDirty = true
        }
      } catch {
        quarantine(file)
        indexDirty = true
      }
    }
    if (indexDirty || cache.index?.count !== metadata.length || cache.journal?.operations.length) {
      try {
        withLock(this.metadataJournalLock, () => {
          const currentIndex = this.readMetadataIndex()
          if (currentIndex?.version === 2 && currentIndex.journalId !== cache.index?.journalId) return
          const journal = this.readMetadataJournal()
          if (cache.journal && journal?.id !== cache.journal.id) return
          if (journal) applyMetadataOperations(entries, journal.operations.slice(cache.journal?.operations.length ?? 0))
          if (Object.keys(entries).length === 0) {
            try { unlinkSync(this.metadataIndexFile) } catch { }
            try { unlinkSync(this.metadataJournalFile) } catch { }
          } else {
            this.writeMetadataSnapshot(entries)
          }
        })
      } catch { }
    }
    return metadata
  }

  loadById(taskId: string): A2AStoredTask | undefined {
    this.ensureMigrated()
    const file = this.recordFile(taskId)
    try {
      return this.readRecordFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') quarantine(file)
      return undefined
    }
  }

  save(task: A2ATask, pushNotificationConfigs: A2APushNotificationConfig[] = [], pendingPushDeliveries: A2APushOutboxEntry[] = []): void {
    this.ensureMigrated()
    const file = this.recordFile(task.id)
    withLock(`${file}.lock`, () => {
      const stored = { task, pushNotificationConfigs, pendingPushDeliveries }
      atomicWriteFile(file, JSON.stringify(stored))
      if (TERMINAL_STATES.has(task.status.state) && pendingPushDeliveries.length === 0) {
        let entry: StoredTaskMetadata | undefined
        try { entry = this.writeMetadata(file, stored) } catch { }
        try {
          if (!entry) {
            const stats = statSync(file)
            entry = {
              metadata: metadataForTask(task, pendingPushDeliveries.length),
              fingerprint: { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino },
            }
          }
          this.appendMetadataOperation({ op: 'set', name: basename(file), entry })
        } catch {
        }
      }
    })
  }

  remove(taskId: string): void {
    this.ensureMigrated()
    const file = this.recordFile(taskId)
    withLock(`${file}.lock`, () => {
      try {
        unlinkSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        unlinkSync(this.metadataFile(taskId))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.appendMetadataOperation({ op: 'delete', name: basename(file) })
    })
  }
}
