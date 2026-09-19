import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../team/atomic.ts'
import { withLock } from '../team/lock.ts'
import { clone, isObject, TASK_STATES } from './protocol.ts'
import type { A2APushNotificationConfig, A2AStoredTask, A2ATask, TaskState } from './types.ts'

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

interface CachedTaskStore {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  tasks: A2AStoredTask[]
}

export class A2aTaskStore {
  private readonly file: string
  private cache?: CachedTaskStore

  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.file = join(root, 'tasks.json')
  }

  load(): A2AStoredTask[] {
    return clone(this.loadInternal())
  }

  private loadInternal(): A2AStoredTask[] {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(this.file)
    } catch {
      this.cache = undefined
      return []
    }
    if (this.cache && this.cache.size === stats.size && this.cache.mtimeMs === stats.mtimeMs && this.cache.ctimeMs === stats.ctimeMs && this.cache.ino === stats.ino) {
      return this.cache.tasks
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('invalid task store')
      const tasks = parsed.flatMap((value): A2AStoredTask[] => {
        if (isPersistedTask(value)) return [{ task: value, pushNotificationConfigs: [] }]
        if (!isObject(value) || !isPersistedTask(value.task)) return []
        const configs = Array.isArray(value.pushNotificationConfigs)
          ? value.pushNotificationConfigs.filter(isPushNotificationConfig)
          : []
        return [{ task: value.task, pushNotificationConfigs: configs }]
      })
      this.cache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, tasks }
      return tasks
    } catch {
      this.quarantineCorrupt()
      return []
    }
  }

  private updateCache(tasks: A2AStoredTask[]): void {
    try {
      const stats = statSync(this.file)
      this.cache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, tasks }
    } catch {
      this.cache = undefined
    }
  }

  private quarantineCorrupt(): void {
    this.cache = undefined
    try {
      renameSync(this.file, `${this.file}.corrupt.${Date.now()}.json`)
    } catch {
    }
  }

  save(task: A2ATask, pushNotificationConfigs: A2APushNotificationConfig[] = []): void {
    withLock(`${this.file}.lock`, () => {
      const tasks = this.loadInternal().filter((item) => item.task.id !== task.id)
      tasks.push({ task: clone(task), pushNotificationConfigs: clone(pushNotificationConfigs) })
      atomicWriteFile(this.file, JSON.stringify(tasks))
      this.updateCache(tasks)
    })
  }

  remove(taskId: string): void {
    withLock(`${this.file}.lock`, () => {
      const tasks = this.loadInternal().filter((item) => item.task.id !== taskId)
      atomicWriteFile(this.file, JSON.stringify(tasks))
      this.updateCache(tasks)
    })
  }
}
