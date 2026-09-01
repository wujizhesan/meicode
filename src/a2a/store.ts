import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
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

export class A2aTaskStore {
  private readonly file: string

  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.file = join(root, 'tasks.json')
  }

  load(): A2AStoredTask[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('invalid task store')
      return parsed.flatMap((value) => {
        if (isPersistedTask(value)) return [{ task: clone(value), pushNotificationConfigs: [] }]
        if (!isObject(value) || !isPersistedTask(value.task)) return []
        const configs = Array.isArray(value.pushNotificationConfigs)
          ? value.pushNotificationConfigs.filter(isPushNotificationConfig).map((config) => clone(config))
          : []
        return [{ task: clone(value.task), pushNotificationConfigs: configs }]
      })
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt.${Date.now()}.json`)
      } catch {
      }
      return []
    }
  }

  save(task: A2ATask, pushNotificationConfigs: A2APushNotificationConfig[] = []): void {
    withLock(`${this.file}.lock`, () => {
      const tasks = this.load().filter((item) => item.task.id !== task.id)
      tasks.push({ task: clone(task), pushNotificationConfigs: clone(pushNotificationConfigs) })
      atomicWriteFile(this.file, JSON.stringify(tasks, null, 2))
    })
  }

  remove(taskId: string): void {
    withLock(`${this.file}.lock`, () => {
      const tasks = this.load().filter((item) => item.task.id !== taskId)
      atomicWriteFile(this.file, JSON.stringify(tasks, null, 2))
    })
  }
}
