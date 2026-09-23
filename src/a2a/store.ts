import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../team/atomic.ts'
import { withLock } from '../team/lock.ts'
import { clone, isObject, TASK_STATES } from './protocol.ts'
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

  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.legacyFile = join(root, 'tasks.json')
    this.recordsDir = join(root, 'records')
    this.migrationMarker = join(root, 'records.ready')
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

  private writeMetadata(file: string, stored: A2AStoredTask): A2aTaskMetadata {
    const stats = statSync(file)
    const metadata = metadataForTask(stored.task, stored.pendingPushDeliveries.length)
    const fingerprint = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino }
    atomicWriteFile(this.metadataFile(stored.task.id), JSON.stringify({ metadata, fingerprint }))
    return metadata
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
    return clone(tasks)
  }

  loadMetadata(): A2aTaskMetadata[] {
    this.ensureMigrated()
    const metadata: A2aTaskMetadata[] = []
    for (const name of readdirSync(this.recordsDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const file = join(this.recordsDir, name)
      const metadataFile = file.replace(/\.json$/, '.meta.json')
      try {
        const stats = statSync(file)
        const parsed: unknown = JSON.parse(readFileSync(metadataFile, 'utf8'))
        if (isStoredTaskMetadata(parsed)
          && this.recordFile(parsed.metadata.id) === file
          && parsed.fingerprint.size === stats.size
          && parsed.fingerprint.mtimeMs === stats.mtimeMs
          && parsed.fingerprint.ctimeMs === stats.ctimeMs
          && parsed.fingerprint.ino === stats.ino) {
          metadata.push(parsed.metadata)
          continue
        }
      } catch { }
      try {
        let rebuilt: A2aTaskMetadata | undefined
        withLock(`${file}.lock`, () => {
          const stored = this.readRecordFile(file)
          rebuilt = metadataForTask(stored.task, stored.pendingPushDeliveries.length)
          try { this.writeMetadata(file, stored) } catch { }
        })
        if (rebuilt) metadata.push(rebuilt)
      } catch {
        quarantine(file)
      }
    }
    return clone(metadata)
  }

  loadById(taskId: string): A2AStoredTask | undefined {
    this.ensureMigrated()
    const file = this.recordFile(taskId)
    try {
      return clone(this.readRecordFile(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') quarantine(file)
      return undefined
    }
  }

  save(task: A2ATask, pushNotificationConfigs: A2APushNotificationConfig[] = [], pendingPushDeliveries: A2APushOutboxEntry[] = []): void {
    this.ensureMigrated()
    const file = this.recordFile(task.id)
    withLock(`${file}.lock`, () => {
      const stored = { task: clone(task), pushNotificationConfigs: clone(pushNotificationConfigs), pendingPushDeliveries: clone(pendingPushDeliveries) }
      atomicWriteFile(file, JSON.stringify(stored))
      try { this.writeMetadata(file, stored) } catch { }
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
    })
  }
}
