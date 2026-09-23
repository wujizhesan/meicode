import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Provider } from './provider/types.ts'
import { History } from './session/history.ts'
import type { ToolRegistry } from './tools/index.ts'
import type { RuleEngine } from './permission/index.ts'
import type { PermissionMode } from './permission/types.ts'
import { runAgent } from './agent/loop.ts'
import { buildPrompt } from './agent/prompt/index.ts'
import { createAgentRuntimeContext, createRuntimeId, recordAudit } from './runtime/index.ts'
import type { RuntimeEventLog } from './runtime/index.ts'
import type { HookEngine } from './hook/engine.ts'
import {
  A2aLimitError,
  clone,
  DEFAULT_TASK_TTL_MS,
  firstText,
  isObject,
  methodName,
  normalizePushNotificationConfig,
  normalizePushAllowedUrls,
  now,
  optionalInt,
  parseMessage,
  rpcRequest,
  TASK_STATES,
  TERMINAL_STATES,
  textMessage,
} from './a2a/protocol.ts'
import { agentCard, isAuthorized, readBody, sendError, sendJson } from './a2a/http.ts'
import { A2aTaskStore, metadataForTask } from './a2a/store.ts'
import type { A2aTaskMetadata } from './a2a/store.ts'
import { A2aMessageIndex } from './a2a/message-index.ts'
import { createA2aSseWriter } from './a2a/sse.ts'
import type {
  A2AArtifact,
  A2AMessage,
  A2APushNotificationConfig,
  A2APushOutboxEntry,
  A2AStreamResponse,
  A2ATask,
  TaskState,
} from './a2a/types.ts'

export { A2aTaskStore } from './a2a/store.ts'
export type {
  A2AArtifact,
  A2AMessage,
  A2APart,
  A2APushNotificationConfig,
  A2AStatus,
  A2AStoredTask,
  A2AStreamResponse,
  A2ATask,
  TaskState,
} from './a2a/types.ts'

interface A2APushJob {
  config: A2APushNotificationConfig
  event: A2AStreamResponse
  epoch: number
  progress: boolean
  deliveryId?: string
}

interface A2APushQueue {
  pending: A2APushJob[]
  running: boolean
}

type PushDeliveryResult = { state: 'delivered' | 'skipped' | 'deferred' } | { state: 'failed'; error: string; retryable: boolean }

interface A2ATaskRecord {
  task: A2ATask
  history: History
  handle?: ReturnType<typeof runAgent>
  events: A2AStreamResponse[]
  listeners: Set<(event: A2AStreamResponse) => void>
  sseConnections: number
  started: boolean
  canceled: boolean
  pushNotificationConfigs: Map<string, A2APushNotificationConfig>
  pushOutbox: Map<string, A2APushOutboxEntry>
  pushQueues: Map<string, A2APushQueue>
  pushEpoch: number
  pushSlotsActive: number
  pushSlotWaiters: Array<(acquired: boolean) => void>
  pendingPush?: A2AStreamResponse
  pushTimer?: ReturnType<typeof setTimeout>
  requestId?: string
}

const PUSH_COALESCE_MS = 100
const MAX_PUSH_CONCURRENCY = 4
const DEFAULT_MAX_CONCURRENT_PUSH_DELIVERIES = 16
const MAX_DURABLE_PUSH_ATTEMPTS = 5
const DEFAULT_PUSH_DRAIN_TIMEOUT_MS = 3000
const DEFAULT_PUSH_OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_PUSH_CONFIGS_PER_TASK = 8
const DEFAULT_MAX_SSE_CONNECTIONS = 64
const DEFAULT_MAX_SSE_CONNECTIONS_PER_TASK = 8
const DEFAULT_MAX_CACHED_COMPLETED_TASKS = 100

export interface A2aOptions {
  provider: Provider
  registry: ToolRegistry
  engine: RuleEngine
  cwd: string
  memoryTail?: string
  baseUrl?: string
  authToken?: string
  pushAllowedUrls?: string[]
  maxConcurrentPushDeliveries?: number
  maxPushConfigsPerTask?: number
  taskRoot?: string
  taskStore?: A2aTaskStore
  maxTasks?: number
  maxActiveTasks?: number
  maxCachedCompletedTasks?: number
  taskTtlMs?: number
  pushOutboxMaxAgeMs?: number
  maxConcurrentTasks?: number
  maxSseConnections?: number
  maxSseConnectionsPerTask?: number
  runtimeEvents?: RuntimeEventLog
  sessionId?: string
  name?: string
  description?: string
  contextWindow?: number
  permissionMode?: PermissionMode
  hooks?: HookEngine
}

function stateMessage(record: A2ATaskRecord, text: string): A2AMessage {
  return textMessage(text, 'ROLE_AGENT', record.task.contextId, record.task.id)
}

function samePushConfig(left: A2APushNotificationConfig | undefined, right: A2APushNotificationConfig): boolean {
  return left?.id === right.id
    && left?.taskId === right.taskId
    && left?.url === right.url
    && left?.token === right.token
    && left?.authentication?.scheme === right.authentication?.scheme
    && left?.authentication?.credentials === right.authentication?.credentials
}

export interface A2aServer extends ReturnType<typeof createServer> {
  drainPushNotifications(timeoutMs?: number, stopOnTimeout?: boolean): Promise<boolean>
}

export function createA2aServer(opts: A2aOptions): A2aServer {
  const allowedPushUrls = normalizePushAllowedUrls(opts.pushAllowedUrls ?? [])
  const tasks = new Map<string, A2ATaskRecord>()
  const taskIndex = new Map<string, A2aTaskMetadata>()
  const completedCache = new Map<string, true>()
  const messageIndex = new A2aMessageIndex()
  const taskStore = opts.taskStore ?? (opts.taskRoot ? new A2aTaskStore(opts.taskRoot) : undefined)
  const maxActiveTasks = opts.maxActiveTasks ?? opts.maxTasks ?? 1000
  if (!Number.isInteger(maxActiveTasks) || maxActiveTasks < 0) throw new Error('A2A maxActiveTasks 无效')
  const maxCachedCompletedTasks = opts.maxCachedCompletedTasks ?? DEFAULT_MAX_CACHED_COMPLETED_TASKS
  if (!Number.isInteger(maxCachedCompletedTasks) || maxCachedCompletedTasks < 0) throw new Error('A2A maxCachedCompletedTasks 无效')
  const taskTtlMs = opts.taskTtlMs ?? DEFAULT_TASK_TTL_MS
  if (!Number.isSafeInteger(taskTtlMs) || taskTtlMs < 0) throw new Error('A2A taskTtlMs 无效')
  const pushOutboxMaxAgeMs = opts.pushOutboxMaxAgeMs ?? DEFAULT_PUSH_OUTBOX_MAX_AGE_MS
  if (!Number.isSafeInteger(pushOutboxMaxAgeMs) || pushOutboxMaxAgeMs < 0) throw new Error('A2A pushOutboxMaxAgeMs 无效')
  const maxConcurrentTasks = opts.maxConcurrentTasks ?? 4
  if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) throw new Error('A2A maxConcurrentTasks 无效')
  const maxPushConfigsPerTask = opts.maxPushConfigsPerTask ?? DEFAULT_MAX_PUSH_CONFIGS_PER_TASK
  if (!Number.isInteger(maxPushConfigsPerTask) || maxPushConfigsPerTask < 0) throw new Error('A2A maxPushConfigsPerTask 无效')
  const maxConcurrentPushDeliveries = opts.maxConcurrentPushDeliveries ?? DEFAULT_MAX_CONCURRENT_PUSH_DELIVERIES
  if (!Number.isInteger(maxConcurrentPushDeliveries) || maxConcurrentPushDeliveries < 1) throw new Error('A2A maxConcurrentPushDeliveries 无效')
  const maxSseConnections = opts.maxSseConnections ?? DEFAULT_MAX_SSE_CONNECTIONS
  const maxSseConnectionsPerTask = opts.maxSseConnectionsPerTask ?? DEFAULT_MAX_SSE_CONNECTIONS_PER_TASK
  if (!Number.isInteger(maxSseConnections) || maxSseConnections < 0) throw new Error('A2A maxSseConnections 无效')
  if (!Number.isInteger(maxSseConnectionsPerTask) || maxSseConnectionsPerTask < 0) throw new Error('A2A maxSseConnectionsPerTask 无效')
  const streamingEnabled = maxSseConnections > 0 && maxSseConnectionsPerTask > 0
  const pushNotificationsEnabled = allowedPushUrls.size > 0 && maxPushConfigsPerTask > 0
  let activeExecutions = 0
  let activeTaskCount = 0
  let activeSseConnections = 0
  const pendingPushDeliveries = new Set<Promise<void>>()
  const readyPushRecords: A2ATaskRecord[] = []
  const readyPushRecordSet = new Set<A2ATaskRecord>()
  const activePushControllers = new Set<AbortController>()
  let activePushDeliveries = 0
  let pushDispatchStopped = false
  const pushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const scheduledOutboxIds = new Set<string>()
  let shuttingDown = false
  const runtimeSessionId = (contextId = 'service'): string => opts.sessionId ?? `a2a:${contextId}`

  const requireSseCapacity = (record?: A2ATaskRecord, requestId?: string): void => {
    if (activeSseConnections >= maxSseConnections) {
      recordAudit(opts.runtimeEvents, { kind: 'a2a_sse_quota_rejected', sessionId: runtimeSessionId(record?.task.contextId), taskId: record?.task.id, requestId, level: 'warn', payload: { scope: 'server', limit: maxSseConnections, active: activeSseConnections } })
      throw new A2aLimitError('SSE 连接数已达服务上限')
    }
    const taskConnections = record?.sseConnections ?? 0
    if (taskConnections >= maxSseConnectionsPerTask) {
      recordAudit(opts.runtimeEvents, { kind: 'a2a_sse_quota_rejected', sessionId: runtimeSessionId(record?.task.contextId), taskId: record?.task.id, requestId, level: 'warn', payload: { scope: 'task', limit: maxSseConnectionsPerTask, active: taskConnections } })
      throw new A2aLimitError('SSE 连接数已达任务上限')
    }
  }

  const persist = (record: A2ATaskRecord): void => {
    taskStore?.save(record.task, [...record.pushNotificationConfigs.values()], [...record.pushOutbox.values()])
    taskIndex.set(record.task.id, metadataForTask(record.task, record.pushOutbox.size))
  }

  const cacheCompleted = (record: A2ATaskRecord): void => {
    if (!taskStore || tasks.get(record.task.id) !== record || !TERMINAL_STATES.has(record.task.status.state)
      || record.pushOutbox.size > 0 || record.handle || record.listeners.size > 0 || record.sseConnections > 0
      || record.pushQueues.size > 0 || record.pushTimer) return
    completedCache.delete(record.task.id)
    completedCache.set(record.task.id, true)
    while (completedCache.size > maxCachedCompletedTasks) {
      const oldest = completedCache.keys().next().value
      if (oldest === undefined) break
      completedCache.delete(oldest)
      tasks.delete(oldest)
    }
  }

  const taskResponse = (record: A2ATaskRecord, historyLength?: number): A2ATask => {
    const task = clone(record.task)
    if (historyLength !== undefined) task.history = historyLength === 0 ? [] : task.history.slice(-historyLength)
    return task
  }

  const pruneTask = (id: string, record: A2ATaskRecord, cutoff = Date.now() - taskTtlMs): boolean => {
    if (!TERMINAL_STATES.has(record.task.status.state)) return false
    const timestamp = Date.parse(record.task.status.timestamp)
    if (!Number.isFinite(timestamp)) return false
    const pendingPushCount = record.pushOutbox.size
    if (pendingPushCount > 0 && Date.now() - timestamp >= pushOutboxMaxAgeMs) {
      recordAudit(opts.runtimeEvents, {
        kind: 'a2a_push_outbox_expired',
        sessionId: runtimeSessionId(record.task.contextId),
        taskId: id,
        level: 'warn',
        payload: { pendingPushCount, pushOutboxMaxAgeMs, taskTtlMs },
      })
      for (const entry of record.pushOutbox.values()) scheduledOutboxIds.delete(entry.deliveryId)
      for (const configId of record.pushNotificationConfigs.keys()) {
        const key = JSON.stringify([id, configId])
        const timer = pushRetryTimers.get(key)
        if (timer) clearTimeout(timer)
        pushRetryTimers.delete(key)
      }
      record.pushOutbox.clear()
      if (taskTtlMs <= 0 || timestamp >= cutoff) persist(record)
    }
    if (taskTtlMs <= 0 || timestamp >= cutoff || record.pushOutbox.size > 0) return false
    if (record.pushTimer) clearTimeout(record.pushTimer)
    for (const configId of record.pushNotificationConfigs.keys()) {
      const key = JSON.stringify([id, configId])
      const timer = pushRetryTimers.get(key)
      if (timer) clearTimeout(timer)
      pushRetryTimers.delete(key)
    }
    record.pushNotificationConfigs.clear()
    messageIndex.removeTask(record.task)
    tasks.delete(id)
    taskIndex.delete(id)
    completedCache.delete(id)
    taskStore?.remove(id)
    return true
  }

  const pruneColdTask = (metadata: A2aTaskMetadata, cutoff: number): boolean => {
    if (taskTtlMs <= 0 || !TERMINAL_STATES.has(metadata.state)) return false
    const timestamp = Date.parse(metadata.timestamp)
    if (!Number.isFinite(timestamp) || timestamp >= cutoff || metadata.pendingPushDeliveries > 0) return false
    messageIndex.removeTaskIds(metadata.id, metadata.messageIds)
    taskIndex.delete(metadata.id)
    completedCache.delete(metadata.id)
    taskStore?.remove(metadata.id)
    return true
  }

  const pruneTasks = (): void => {
    const cutoff = Date.now() - taskTtlMs
    for (const metadata of taskIndex.values()) {
      const record = tasks.get(metadata.id)
      if (record) {
        if (!pruneTask(metadata.id, record, cutoff)) cacheCompleted(record)
      } else {
        pruneColdTask(metadata, cutoff)
      }
    }
  }

  const listTasks = (filters: { contextId?: unknown; status?: unknown; pageSize?: unknown; pageToken?: unknown }): { tasks: A2ATask[]; totalSize: number; nextPageToken?: string } => {
    pruneTasks()
    const contextId = filters.contextId === undefined ? undefined : String(filters.contextId)
    const status = filters.status === undefined ? undefined : String(filters.status)
    if (status && !TASK_STATES.has(status as TaskState)) throw new Error('status 无效')
    const filtered = [...taskIndex.values()]
      .filter((metadata) => !contextId || metadata.contextId === contextId)
      .filter((metadata) => !status || metadata.state === status)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    const pageSize = optionalInt(filters.pageSize, 'pageSize', 100) ?? 50
    if (pageSize === 0) throw new Error('pageSize 无效')
    let cursor: string | undefined
    if (filters.pageToken !== undefined && filters.pageToken !== '') {
      if (typeof filters.pageToken !== 'string' || filters.pageToken.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(filters.pageToken)) throw new Error('pageToken 无效')
      const decoded = Buffer.from(filters.pageToken, 'base64url').toString('utf8')
      if (!decoded.startsWith('v1:') || decoded.length <= 3 || decoded.length > 131 || Buffer.from(decoded).toString('base64url') !== filters.pageToken) throw new Error('pageToken 无效')
      cursor = decoded.slice(3)
    }
    const cursorIndex = cursor === undefined ? 0 : filtered.findIndex((metadata) => metadata.id > cursor)
    const offset = cursorIndex < 0 ? filtered.length : cursorIndex
    const page = filtered.slice(offset, offset + pageSize).map((metadata) => taskResponse(findRecord(metadata.id)))
    const next = offset + page.length < filtered.length ? Buffer.from(`v1:${page[page.length - 1].id}`).toString('base64url') : undefined
    return { tasks: page, totalSize: filtered.length, ...(next ? { nextPageToken: next } : {}) }
  }

  const deliverPush = async (config: A2APushNotificationConfig, event: A2AStreamResponse, shouldSkip: () => boolean, deliveryId?: string): Promise<PushDeliveryResult> => {
    if (pushDispatchStopped) return { state: 'deferred' }
    if (!allowedPushUrls.has(config.url)) return { state: 'skipped' }
    let lastError = '投递失败'
    let retryable = true
    const maxAttempts = deliveryId ? 1 : 2
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (pushDispatchStopped) return { state: 'deferred' }
      if (shouldSkip()) return { state: 'skipped' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      activePushControllers.add(controller)
      try {
        const headers: Record<string, string> = { 'content-type': 'application/a2a+json' }
        if (config.token) headers['X-A2A-Notification-Token'] = config.token
        if (config.authentication) headers.authorization = `${config.authentication.scheme} ${config.authentication.credentials}`
        if (deliveryId) headers['X-A2A-Delivery-Id'] = deliveryId
        const response = await fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          signal: controller.signal,
          redirect: 'error',
        })
        try {
          await response.body?.cancel()
        } catch {
          controller.abort()
        }
        if (response.ok) {
          return { state: 'delivered' }
        }
        lastError = `HTTP ${response.status}`
        retryable = response.status === 408 || response.status === 429 || response.status >= 500
      } catch (error) {
        lastError = (error as Error).message
        retryable = true
      } finally {
        clearTimeout(timer)
        activePushControllers.delete(controller)
      }
      if (pushDispatchStopped) return { state: 'deferred' }
      if (!retryable) break
      if (attempt + 1 < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { state: 'failed', error: lastError, retryable }
  }

  const markPushRecordReady = (record: A2ATaskRecord): void => {
    if (record.pushSlotWaiters.length === 0 || record.pushSlotsActive >= MAX_PUSH_CONCURRENCY || readyPushRecordSet.has(record)) return
    readyPushRecordSet.add(record)
    readyPushRecords.push(record)
  }

  const pumpPushSlots = (): void => {
    while (!pushDispatchStopped && activePushDeliveries < maxConcurrentPushDeliveries && readyPushRecords.length > 0) {
      const record = readyPushRecords.shift()!
      readyPushRecordSet.delete(record)
      if (record.pushSlotWaiters.length === 0 || record.pushSlotsActive >= MAX_PUSH_CONCURRENCY) continue
      const next = record.pushSlotWaiters.shift()!
      record.pushSlotsActive++
      activePushDeliveries++
      markPushRecordReady(record)
      next(true)
    }
  }

  const acquirePushSlot = (record: A2ATaskRecord): Promise<boolean> => new Promise((resolve) => {
    if (pushDispatchStopped) return resolve(false)
    record.pushSlotWaiters.push(resolve)
    markPushRecordReady(record)
    pumpPushSlots()
  })

  const releasePushSlot = (record: A2ATaskRecord): void => {
    record.pushSlotsActive--
    activePushDeliveries--
    markPushRecordReady(record)
    pumpPushSlots()
  }

  const stopPushDispatch = (): void => {
    if (pushDispatchStopped) return
    pushDispatchStopped = true
    for (const controller of activePushControllers) controller.abort()
    for (const timer of pushRetryTimers.values()) clearTimeout(timer)
    pushRetryTimers.clear()
    readyPushRecords.length = 0
    readyPushRecordSet.clear()
    for (const record of tasks.values()) {
      for (const queue of record.pushQueues.values()) {
        for (const job of queue.pending) {
          if (job.deliveryId) scheduledOutboxIds.delete(job.deliveryId)
        }
        queue.pending.length = 0
      }
      for (const resolve of record.pushSlotWaiters.splice(0)) resolve(false)
    }
  }

  const reportPushFailure = (record: A2ATaskRecord, job: A2APushJob, error: string, attempts: number): void => {
    let target = 'unknown'
    try { target = new URL(job.config.url).host } catch { }
    recordAudit(opts.runtimeEvents, {
      kind: 'a2a_push_failed',
      sessionId: runtimeSessionId(record.task.contextId),
      taskId: record.task.id,
      level: 'warn',
      payload: { target, error, eventType: Object.keys(job.event)[0] ?? 'unknown', attempts, ...(job.deliveryId ? { deliveryId: job.deliveryId } : {}) },
    })
  }

  const outboxEvent = (record: A2ATaskRecord, entry: A2APushOutboxEntry): A2AStreamResponse | undefined => {
    if (entry.event.kind === 'terminal') {
      return { statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: clone(entry.event.status), final: true } }
    }
    const artifactId = entry.event.artifactId
    const artifact = record.task.artifacts.find((item) => item.artifactId === artifactId)
    if (!artifact) return undefined
    return { artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId, artifact: clone(artifact), append: entry.event.append, lastChunk: entry.event.lastChunk } }
  }

  const retryKey = (taskId: string, configId: string): string => JSON.stringify([taskId, configId])

  const drainPushQueue = async (record: A2ATaskRecord, configId: string, queue: A2APushQueue): Promise<void> => {
    if (queue.running) return
    queue.running = true
    try {
      while (queue.pending.length > 0) {
        const job = queue.pending.shift()!
        const shouldSkip = (): boolean => (job.progress && job.epoch !== record.pushEpoch)
          || (job.deliveryId ? !record.pushOutbox.has(job.deliveryId) || !samePushConfig(record.pushNotificationConfigs.get(configId), job.config) : record.pushNotificationConfigs.get(configId) !== job.config)
        let result: PushDeliveryResult = pushDispatchStopped ? { state: 'deferred' } : { state: 'skipped' }
        try {
          if (!pushDispatchStopped && !shouldSkip()) {
            const acquired = await acquirePushSlot(record)
            if (acquired) {
              try {
                if (!shouldSkip()) result = await deliverPush(job.config, job.event, shouldSkip, job.deliveryId)
              } finally {
                releasePushSlot(record)
              }
            } else {
              result = { state: 'deferred' }
            }
          }
        } catch (error) {
          result = { state: 'failed', error: (error as Error).message, retryable: true }
        }
        if (!job.deliveryId) {
          if (result.state === 'failed') reportPushFailure(record, job, result.error, 2)
          continue
        }
        scheduledOutboxIds.delete(job.deliveryId)
        const entry = record.pushOutbox.get(job.deliveryId)
        if (entry && result.state !== 'deferred') {
          if (result.state === 'failed') {
            entry.attempts++
            if (result.retryable && entry.attempts < MAX_DURABLE_PUSH_ATTEMPTS) {
              entry.nextAttemptAt = Date.now() + Math.min(30_000, 1000 * 2 ** (entry.attempts - 1))
            } else {
              record.pushOutbox.delete(entry.deliveryId)
              reportPushFailure(record, job, result.error, entry.attempts)
            }
          } else {
            record.pushOutbox.delete(entry.deliveryId)
          }
          persist(record)
        }
        scheduleOutboxForConfig(record, configId)
      }
    } finally {
      queue.running = false
      if (record.pushQueues.get(configId) === queue) record.pushQueues.delete(configId)
      cacheCompleted(record)
    }
  }

  const enqueuePushJob = (record: A2ATaskRecord, job: A2APushJob, force = false): void => {
    if (pushDispatchStopped) return
    let queue = record.pushQueues.get(job.config.id)
    if (!queue) {
      queue = { pending: [], running: false }
      record.pushQueues.set(job.config.id, queue)
    }
    if (job.progress || force) queue.pending = queue.pending.filter((pending) => !pending.progress)
    queue.pending.push(job)
    if (!queue.running) {
      const delivery = drainPushQueue(record, job.config.id, queue)
      pendingPushDeliveries.add(delivery)
      void delivery.then(
        () => pendingPushDeliveries.delete(delivery),
        () => pendingPushDeliveries.delete(delivery),
      )
    }
  }

  const scheduleOutboxForConfig = (record: A2ATaskRecord, configId: string): void => {
    if (pushDispatchStopped) return
    const key = retryKey(record.task.id, configId)
    const timer = pushRetryTimers.get(key)
    if (timer) clearTimeout(timer)
    pushRetryTimers.delete(key)
    const entry = [...record.pushOutbox.values()].find((item) => item.config.id === configId)
    if (!entry) return
    if (!samePushConfig(record.pushNotificationConfigs.get(configId), entry.config) || !allowedPushUrls.has(entry.config.url) || entry.attempts >= MAX_DURABLE_PUSH_ATTEMPTS) {
      record.pushOutbox.delete(entry.deliveryId)
      persist(record)
      scheduleOutboxForConfig(record, configId)
      return
    }
    if (scheduledOutboxIds.has(entry.deliveryId)) return
    const remaining = entry.nextAttemptAt - Date.now()
    if (remaining > 0) {
      if (shuttingDown) return
      const retryTimer = setTimeout(() => {
        pushRetryTimers.delete(key)
        scheduleOutboxForConfig(record, configId)
      }, remaining)
      retryTimer.unref?.()
      pushRetryTimers.set(key, retryTimer)
      return
    }
    const event = outboxEvent(record, entry)
    if (!event) {
      record.pushOutbox.delete(entry.deliveryId)
      persist(record)
      scheduleOutboxForConfig(record, configId)
      return
    }
    scheduledOutboxIds.add(entry.deliveryId)
    enqueuePushJob(record, { config: entry.config, event, epoch: record.pushEpoch, progress: false, deliveryId: entry.deliveryId }, entry.event.kind === 'terminal')
  }

  const queuePush = (record: A2ATaskRecord, event: A2AStreamResponse, force = false): void => {
    if (record.pushNotificationConfigs.size === 0) return
    const epoch = force ? ++record.pushEpoch : record.pushEpoch
    const progress = event.statusUpdate?.status.state === 'TASK_STATE_WORKING' && !event.statusUpdate.final
    const payload = clone(event)
    const configs = [...record.pushNotificationConfigs.values()]
    const durableEvent: A2APushOutboxEntry['event'] | undefined = event.artifactUpdate
      ? { kind: 'artifact', artifactId: event.artifactUpdate.artifact.artifactId, append: event.artifactUpdate.append, lastChunk: event.artifactUpdate.lastChunk }
      : event.statusUpdate?.final ? { kind: 'terminal', status: clone(event.statusUpdate.status) } : undefined
    if (durableEvent) {
      const entries = configs.map((config): A2APushOutboxEntry => ({
        deliveryId: createRuntimeId('event'),
        config: clone(config),
        event: clone(durableEvent),
        attempts: 0,
        nextAttemptAt: Date.now(),
      }))
      for (const entry of entries) record.pushOutbox.set(entry.deliveryId, entry)
      try {
        persist(record)
      } catch (error) {
        for (const entry of entries) record.pushOutbox.delete(entry.deliveryId)
        throw error
      }
      for (const config of configs) scheduleOutboxForConfig(record, config.id)
      return
    }
    for (const config of configs) enqueuePushJob(record, { config, event: payload, epoch, progress }, force)
  }

  const clearPendingPush = (record: A2ATaskRecord): void => {
    if (record.pushTimer) clearTimeout(record.pushTimer)
    record.pushTimer = undefined
    record.pendingPush = undefined
  }

  const flushPendingPush = (record: A2ATaskRecord): void => {
    if (record.pushTimer) clearTimeout(record.pushTimer)
    record.pushTimer = undefined
    const pending = record.pendingPush
    record.pendingPush = undefined
    if (pending) queuePush(record, pending)
  }

  const schedulePush = (record: A2ATaskRecord, event: A2AStreamResponse): void => {
    if (record.pushNotificationConfigs.size === 0) return
    const terminal = Boolean(event.statusUpdate?.final) || Boolean(event.task && TERMINAL_STATES.has(event.task.status.state))
    if (terminal) {
      clearPendingPush(record)
      queuePush(record, event, true)
      return
    }
    if (event.statusUpdate?.status.state === 'TASK_STATE_WORKING') {
      record.pendingPush = clone(event)
      if (!record.pushTimer) {
        record.pushTimer = setTimeout(() => flushPendingPush(record), PUSH_COALESCE_MS)
        record.pushTimer.unref?.()
      }
      return
    }
    flushPendingPush(record)
    queuePush(record, event)
  }

  const notify = (record: A2ATaskRecord, event: A2AStreamResponse): void => {
    record.events.push(clone(event))
    if (record.events.length > 1000) record.events.shift()
    for (const listener of record.listeners) listener(clone(event))
    schedulePush(record, event)
  }

  const setStatus = (record: A2ATaskRecord, state: TaskState, message?: string, final = false): void => {
    const wasActive = !TERMINAL_STATES.has(record.task.status.state)
    const isActive = !TERMINAL_STATES.has(state)
    if (wasActive && !isActive) activeTaskCount--
    else if (!wasActive && isActive) activeTaskCount++
    record.task.status = {
      state,
      timestamp: now(),
      ...(message ? { message: stateMessage(record, message) } : {}),
    }
    notify(record, { statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: clone(record.task.status), final } })
    persist(record)
  }

  const cancelTask = (record: A2ATaskRecord, requestId: string): A2ATask => {
    record.canceled = true
    record.handle?.cancel()
    recordAudit(opts.runtimeEvents, {
      kind: 'a2a_cancel_requested',
      sessionId: runtimeSessionId(record.task.contextId),
      taskId: record.task.id,
      requestId,
      payload: { status: record.task.status.state },
    })
    if (!TERMINAL_STATES.has(record.task.status.state)) setStatus(record, 'TASK_STATE_CANCELED', '任务已取消', true)
    cacheCompleted(record)
    return clone(record.task)
  }

  const requirePushConfigCapacity = (record: A2ATaskRecord | undefined, configId: string, requestId?: string): void => {
    if (record?.pushNotificationConfigs.has(configId)) return
    const count = record?.pushNotificationConfigs.size ?? 0
    if (count < maxPushConfigsPerTask) return
    recordAudit(opts.runtimeEvents, {
      kind: 'a2a_push_config_quota_rejected',
      sessionId: runtimeSessionId(record?.task.contextId),
      taskId: record?.task.id,
      requestId,
      level: 'warn',
      payload: { limit: maxPushConfigsPerTask, count },
    })
    throw new A2aLimitError('Push Notification 配置数量已达任务上限')
  }

  const savePushConfig = (record: A2ATaskRecord, config: A2APushNotificationConfig, requestId?: string): void => {
    requirePushConfigCapacity(record, config.id, requestId)
    if (!samePushConfig(record.pushNotificationConfigs.get(config.id), config)) {
      for (const entry of record.pushOutbox.values()) {
        if (entry.config.id === config.id) record.pushOutbox.delete(entry.deliveryId)
      }
    }
    record.pushNotificationConfigs.set(config.id, config)
    persist(record)
    scheduleOutboxForConfig(record, config.id)
    cacheCompleted(record)
  }

  const addPushConfig = (record: A2ATaskRecord, value: unknown, requestId?: string): A2APushNotificationConfig => {
    const config = normalizePushNotificationConfig(value, record.task.id, allowedPushUrls)
    savePushConfig(record, config, requestId)
    return config
  }

  const getPushConfig = (record: A2ATaskRecord, configId: string): A2APushNotificationConfig => {
    const config = record.pushNotificationConfigs.get(configId)
    if (!config) throw new Error(`Push Notification config not found: ${configId}`)
    return clone(config)
  }

  const listPushConfigs = (record: A2ATaskRecord): A2APushNotificationConfig[] =>
    [...record.pushNotificationConfigs.values()].map((config) => clone(config))

  const deletePushConfig = (record: A2ATaskRecord, configId: string): void => {
    record.pushNotificationConfigs.delete(configId)
    for (const entry of record.pushOutbox.values()) {
      if (entry.config.id === configId) record.pushOutbox.delete(entry.deliveryId)
    }
    persist(record)
    scheduleOutboxForConfig(record, configId)
    cacheCompleted(record)
  }

  const newRecord = (message: A2AMessage, pushNotificationConfig?: A2APushNotificationConfig, requestId?: string): A2ATaskRecord => {
    const task: A2ATask = {
      id: createRuntimeId('task'),
      contextId: message.contextId || createRuntimeId('session'),
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: now() },
      history: [{ ...message, contextId: message.contextId || undefined }],
      artifacts: [],
    }
    const record: A2ATaskRecord = {
      task,
      history: new History(),
      events: [],
      listeners: new Set(),
      sseConnections: 0,
      started: false,
      canceled: false,
      pushNotificationConfigs: new Map(pushNotificationConfig ? [[pushNotificationConfig.id, { ...pushNotificationConfig, taskId: task.id }]] : []),
      pushOutbox: new Map(),
      pushQueues: new Map(),
      pushEpoch: 0,
      pushSlotsActive: 0,
      pushSlotWaiters: [],
      requestId,
    }
    record.history.push({ role: 'user', content: firstText(message) })
    tasks.set(task.id, record)
    activeTaskCount++
    messageIndex.addTask(task)
    recordAudit(opts.runtimeEvents, { kind: 'a2a_task_created', sessionId: runtimeSessionId(task.contextId), taskId: task.id, requestId, payload: { protocol: 'a2a' } })
    notify(record, { task: clone(task) })
    persist(record)
    return record
  }

  const restoreRecord = (task: A2ATask): A2ATaskRecord => {
    const history = new History()
    for (const message of task.history) {
      const content = firstText(message)
      if (!content) continue
      history.push({ role: message.role === 'ROLE_AGENT' ? 'assistant' : 'user', content })
    }
    return { task, history, events: [], listeners: new Set(), sseConnections: 0, started: false, canceled: false, pushNotificationConfigs: new Map(), pushOutbox: new Map(), pushQueues: new Map(), pushEpoch: 0, pushSlotsActive: 0, pushSlotWaiters: [] }
  }

  for (const metadata of taskStore?.loadMetadata() ?? []) {
    taskIndex.set(metadata.id, metadata)
    messageIndex.addTaskIds(metadata.id, metadata.messageIds)
    if (TERMINAL_STATES.has(metadata.state) && metadata.pendingPushDeliveries === 0) {
      pruneColdTask(metadata, Date.now() - taskTtlMs)
      continue
    }
    const stored = taskStore?.loadById(metadata.id)
    if (!stored) {
      messageIndex.removeTaskIds(metadata.id, metadata.messageIds)
      taskIndex.delete(metadata.id)
      continue
    }
    const actualMetadata = metadataForTask(stored.task, stored.pendingPushDeliveries.length)
    messageIndex.removeTaskIds(metadata.id, metadata.messageIds)
    messageIndex.addTaskIds(actualMetadata.id, actualMetadata.messageIds)
    taskIndex.set(actualMetadata.id, actualMetadata)
    const record = restoreRecord(stored.task)
    for (const config of stored.pushNotificationConfigs) record.pushNotificationConfigs.set(config.id, config)
    for (const entry of stored.pendingPushDeliveries) record.pushOutbox.set(entry.deliveryId, entry)
    const previous = tasks.get(stored.task.id)
    if (previous && !TERMINAL_STATES.has(previous.task.status.state)) activeTaskCount--
    tasks.set(stored.task.id, record)
    if (!TERMINAL_STATES.has(stored.task.status.state)) activeTaskCount++
    if (pruneTask(stored.task.id, record)) continue
    for (const configId of new Set(stored.pendingPushDeliveries.map((entry) => entry.config.id))) scheduleOutboxForConfig(record, configId)
    if (stored.task.status.state === 'TASK_STATE_SUBMITTED' || stored.task.status.state === 'TASK_STATE_WORKING') {
      setStatus(record, 'TASK_STATE_FAILED', '服务重启，任务未完成', true)
    }
  }
  pruneTasks()
  const pruneTimer = setInterval(pruneTasks, Math.min(Math.max(taskTtlMs, 60_000), 60 * 60 * 1000))
  pruneTimer.unref?.()

  const findRecord = (id: unknown): A2ATaskRecord => {
    if (typeof id !== 'string' || !id || id.length > 128 || /[\0\r\n]/.test(id)) throw new Error('缺少或无效的 task id')
    const metadata = taskIndex.get(id)
    if (!metadata) throw new Error(`Task not found: ${id}`)
    let record = tasks.get(id)
    if (!record) {
      if (pruneColdTask(metadata, Date.now() - taskTtlMs)) throw new Error(`Task not found: ${id}`)
      const stored = taskStore?.loadById(id)
      if (!stored) {
        messageIndex.removeTaskIds(id, metadata.messageIds)
        taskIndex.delete(id)
        throw new Error(`Task not found: ${id}`)
      }
      const actualMetadata = metadataForTask(stored.task, stored.pendingPushDeliveries.length)
      messageIndex.removeTaskIds(id, metadata.messageIds)
      messageIndex.addTaskIds(id, actualMetadata.messageIds)
      taskIndex.set(id, actualMetadata)
      record = restoreRecord(stored.task)
      for (const config of stored.pushNotificationConfigs) record.pushNotificationConfigs.set(config.id, config)
      for (const entry of stored.pendingPushDeliveries) record.pushOutbox.set(entry.deliveryId, entry)
      tasks.set(id, record)
      for (const configId of new Set(stored.pendingPushDeliveries.map((entry) => entry.config.id))) scheduleOutboxForConfig(record, configId)
    }
    if (pruneTask(id, record)) throw new Error(`Task not found: ${id}`)
    cacheCompleted(record)
    return record
  }

  const recordForMessage = (body: Record<string, unknown>, requestId?: string, streaming = false): A2ATaskRecord => {
    if (streaming) requireSseCapacity(undefined, requestId)
    const message = parseMessage(body.message)
    const configuration = body.configuration
    const pushConfigValue = isObject(configuration) ? configuration.taskPushNotificationConfig : undefined
    if (configuration !== undefined && !isObject(configuration)) throw new Error('configuration 必须是对象')
    const pushConfig = pushConfigValue === undefined ? undefined : normalizePushNotificationConfig(pushConfigValue, '', allowedPushUrls)
    const taskId = message.taskId ?? (typeof body.taskId === 'string' ? body.taskId : undefined)
    let existingByMessageId: A2ATaskRecord | undefined
    while (true) {
      const existingTaskId = messageIndex.taskIdFor(message.messageId)
      if (!existingTaskId) break
      try {
        existingByMessageId = findRecord(existingTaskId)
        break
      } catch (error) {
        if (taskIndex.has(existingTaskId)) throw error
      }
    }
    if (existingByMessageId) {
      if (taskId && taskId !== existingByMessageId.task.id) throw new Error('messageId 已用于其他任务')
      if (streaming) requireSseCapacity(existingByMessageId, requestId)
      if (pushConfig) {
        pushConfig.taskId = existingByMessageId.task.id
        savePushConfig(existingByMessageId, pushConfig, requestId)
      }
      return existingByMessageId
    }
    if (taskId) {
      const record = findRecord(taskId)
      if (record.started || TERMINAL_STATES.has(record.task.status.state)) throw new Error('任务已开始或已结束，不能继续发送消息')
      if (streaming) requireSseCapacity(record, requestId)
      if (pushConfig) requirePushConfigCapacity(record, pushConfig.id, requestId)
      message.taskId = record.task.id
      message.contextId = record.task.contextId
      record.task.history.push(message)
      messageIndex.addMessage(record.task.id, message)
      record.history.push({ role: 'user', content: firstText(message) })
      if (pushConfig) {
        pushConfig.taskId = record.task.id
        savePushConfig(record, pushConfig, requestId)
      }
      return record
    }
    if (activeTaskCount >= maxActiveTasks) {
      recordAudit(opts.runtimeEvents, { kind: 'a2a_quota_rejected', sessionId: runtimeSessionId(), requestId, level: 'warn', payload: { maxActiveTasks, activeTaskCount } })
      throw new A2aLimitError('进行中的任务数量已达上限')
    }
    if (pushConfig) requirePushConfigCapacity(undefined, pushConfig.id, requestId)
    return newRecord(message, pushConfig, requestId)
  }

  const execute = async (record: A2ATaskRecord): Promise<void> => {
    if (record.started || TERMINAL_STATES.has(record.task.status.state)) return
    record.started = true
    if (activeExecutions >= maxConcurrentTasks) {
      setStatus(record, 'TASK_STATE_FAILED', '并发任务数量已达上限', true)
      recordAudit(opts.runtimeEvents, { kind: 'a2a_concurrency_rejected', sessionId: runtimeSessionId(record.task.contextId), taskId: record.task.id, requestId: record.requestId, level: 'warn', payload: { activeExecutions, maxConcurrentTasks } })
      cacheCompleted(record)
      return
    }
    activeExecutions++
    const agentId = createRuntimeId('agent')
    const startedAt = Date.now()
    recordAudit(opts.runtimeEvents, { kind: 'a2a_task_started', sessionId: runtimeSessionId(record.task.contextId), agentId, taskId: record.task.id, requestId: record.requestId, payload: { protocol: 'a2a' } })
    setStatus(record, 'TASK_STATE_WORKING', '任务执行中')
    const ctx = createAgentRuntimeContext({
      provider: opts.provider,
      history: record.history,
      engine: opts.engine,
      cwd: opts.cwd,
      sessionId: runtimeSessionId(record.task.contextId),
      agentId,
      taskId: record.task.id,
      runtimeEvents: opts.runtimeEvents,
      contextWindow: opts.contextWindow,
      permissionMode: opts.permissionMode,
      hooks: opts.hooks,
    })
    try {
      record.handle = runAgent({
        provider: opts.provider,
        history: record.history,
        registry: opts.registry,
        ctx,
        maxIterations: 50,
        mode: 'full',
        systemPrompt: buildPrompt('full') + (opts.memoryTail ?? ''),
        unknownToolLimit: 2,
      })
      for await (const event of record.handle.events) {
        if (record.canceled) continue
        if (event.type === 'text' && event.text) {
          notify(record, { statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: { state: 'TASK_STATE_WORKING', timestamp: now(), message: stateMessage(record, event.text) } } })
        } else if (event.type === 'progress') {
          notify(record, { statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: { state: 'TASK_STATE_WORKING', timestamp: now(), message: stateMessage(record, event.status) } } })
        }
      }
      const result = await record.handle.done
      if (record.canceled || result.reason === 'cancelled') {
        if (record.task.status.state !== 'TASK_STATE_CANCELED') setStatus(record, 'TASK_STATE_CANCELED', '任务已取消', true)
        recordAudit(opts.runtimeEvents, { kind: 'a2a_task_finished', sessionId: runtimeSessionId(record.task.contextId), agentId, taskId: record.task.id, requestId: record.requestId, payload: { durationMs: Date.now() - startedAt, status: 'canceled', reason: 'cancelled' } })
        return
      }
      if (result.reason === 'complete') {
        if (result.finalText) {
          const artifact: A2AArtifact = { artifactId: createRuntimeId('report'), name: 'response.txt', parts: [{ kind: 'text', text: result.finalText }] }
          record.task.artifacts.push(artifact)
          const responseMessage = textMessage(result.finalText, 'ROLE_AGENT', record.task.contextId, record.task.id)
          record.task.history.push(responseMessage)
          messageIndex.addMessage(record.task.id, responseMessage)
          notify(record, { artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId, artifact: clone(artifact), append: false, lastChunk: true } })
          persist(record)
        }
        setStatus(record, 'TASK_STATE_COMPLETED', undefined, true)
        recordAudit(opts.runtimeEvents, { kind: 'a2a_task_finished', sessionId: runtimeSessionId(record.task.contextId), agentId, taskId: record.task.id, requestId: record.requestId, payload: { durationMs: Date.now() - startedAt, status: 'completed', reason: result.reason, totalTokens: result.totalTokens } })
      } else {
        setStatus(record, 'TASK_STATE_FAILED', result.errorMessage ?? `Agent stopped: ${result.reason}`, true)
        recordAudit(opts.runtimeEvents, { kind: 'a2a_task_finished', sessionId: runtimeSessionId(record.task.contextId), agentId, taskId: record.task.id, requestId: record.requestId, level: 'warn', payload: { durationMs: Date.now() - startedAt, status: 'failed', reason: result.reason, error: result.errorMessage ?? '' } })
      }
    } catch (error) {
      if (!record.canceled) setStatus(record, 'TASK_STATE_FAILED', (error as Error).message, true)
      recordAudit(opts.runtimeEvents, { kind: 'a2a_task_failed', sessionId: runtimeSessionId(record.task.contextId), agentId, taskId: record.task.id, requestId: record.requestId, level: 'error', payload: { durationMs: Date.now() - startedAt, error: (error as Error).message } })
    } finally {
      record.handle = undefined
      activeExecutions = Math.max(0, activeExecutions - 1)
      const sessionId = runtimeSessionId(record.task.contextId)
      opts.hooks?.clearAgent?.(sessionId, agentId)
      const scopeStillActive = [...tasks.values()].some((candidate) => (
        candidate !== record
        && runtimeSessionId(candidate.task.contextId) === sessionId
        && !TERMINAL_STATES.has(candidate.task.status.state)
      ))
      if (!scopeStillActive) {
        opts.hooks?.clearSession?.(sessionId)
        opts.engine.clearSessionRules(sessionId)
      }
      for (const listener of record.listeners) {
        if (TERMINAL_STATES.has(record.task.status.state)) listener({ task: clone(record.task) })
      }
      cacheCompleted(record)
    }
  }

  const stream = (res: ServerResponse, record: A2ATaskRecord, rpcId?: string | number | null, requestId?: string): void => {
    requireSseCapacity(record, requestId)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const write = (event: A2AStreamResponse): void => writer.write(event)
    const writer = createA2aSseWriter(res, rpcId, (reason) => {
      record.listeners.delete(write)
      record.sseConnections--
      activeSseConnections--
      cacheCompleted(record)
      if (reason === 'overflow' || reason === 'timeout' || reason === 'write-error') {
        recordAudit(opts.runtimeEvents, {
          kind: 'a2a_sse_disconnected',
          sessionId: runtimeSessionId(record.task.contextId),
          taskId: record.task.id,
          level: 'warn',
          payload: { reason },
        })
      }
    })
    record.sseConnections++
    activeSseConnections++
    for (const event of record.events) write(event)
    if (TERMINAL_STATES.has(record.task.status.state)) {
      writer.finish()
      return
    }
    if (!writer.isClosed()) record.listeners.add(write)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const requestHeader = req.headers['x-request-id']
    const requestId = typeof requestHeader === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestHeader) ? requestHeader : createRuntimeId('request')
    res.setHeader('x-request-id', requestId)
    if (!isAuthorized(req, opts.authToken)) {
      recordAudit(opts.runtimeEvents, { kind: 'a2a_auth_rejected', sessionId: runtimeSessionId(), requestId, level: 'warn', payload: { method: req.method, path: url.pathname } })
      res.writeHead(401, { 'content-type': 'application/a2a+json; charset=utf-8', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: '需要 Bearer token' } }))
      return
    }
    const version = req.headers['a2a-version']
    if (version && version !== '1.0' && version !== '0.3') {
      sendError(res, 400, `不支持的 A2A 版本: ${String(version)}`)
      return
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json')) {
        sendJson(res, 200, agentCard(req, { ...opts, streaming: streamingEnabled, pushNotifications: pushNotificationsEnabled }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, tasks: taskIndex.size })
        return
      }

      const body = await readBody(req)
      const isRpc = req.method === 'POST' && (url.pathname === '/' || url.pathname === '/a2a') && isObject(body) && body.jsonrpc === '2.0'
      if (isRpc) {
        const { request, params, id } = rpcRequest(body)
        const mapped = methodName(String(request.method))
        if (!mapped) {
          sendError(res, 404, `未知 A2A 方法: ${String(request.method)}`, id, -32601)
          return
        }
        if (mapped === 'send' || mapped === 'stream') {
          const record = recordForMessage(params, requestId, mapped === 'stream')
          if (mapped === 'stream') {
            stream(res, record, id, requestId)
            void execute(record)
          } else {
            const configuration = isObject(params.configuration) ? params.configuration : {}
            const historyLength = optionalInt(configuration.historyLength, 'historyLength', 1000)
            if (configuration.returnImmediately === true) {
              void execute(record)
            } else {
              await execute(record)
            }
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { task: taskResponse(record, historyLength) } })
          }
          return
        }
        if (mapped === 'get') {
          const record = findRecord(params.id)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { task: taskResponse(record, optionalInt(params.historyLength, 'historyLength', 1000)) } })
          return
        }
        if (mapped === 'list') {
          sendJson(res, 200, { jsonrpc: '2.0', id, result: listTasks(params) })
          return
        }
        if (mapped === 'cancel') {
          const record = findRecord(params.id)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { task: cancelTask(record, requestId) } })
          return
        }
        if (mapped === 'push_create') {
          const taskId = typeof params.taskId === 'string' ? params.taskId : typeof params.id === 'string' ? params.id : ''
          const record = findRecord(taskId)
          const config = addPushConfig(record, isObject(params.config) ? params.config : params, requestId)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { config } })
          return
        }
        if (mapped === 'push_get' || mapped === 'push_delete') {
          const taskId = typeof params.taskId === 'string' ? params.taskId : ''
          const record = findRecord(taskId)
          const configId = typeof params.configId === 'string' ? params.configId : typeof params.id === 'string' ? params.id : ''
          if (mapped === 'push_delete') {
            getPushConfig(record, configId)
            deletePushConfig(record, configId)
            sendJson(res, 200, { jsonrpc: '2.0', id, result: {} })
          } else {
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { config: getPushConfig(record, configId) } })
          }
          return
        }
        if (mapped === 'push_list') {
          const record = findRecord(params.taskId)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { configs: listPushConfigs(record) } })
          return
        }
        const record = findRecord(params.id)
        if (TERMINAL_STATES.has(record.task.status.state)) {
          sendError(res, 409, '终态任务不支持订阅', id, -32003)
          return
        }
        stream(res, record, id, requestId)
        return
      }

      if (req.method === 'POST' && url.pathname === '/message:send') {
        if (!isObject(body)) throw new Error('请求体必须是对象')
        const record = recordForMessage(body, requestId)
        const configuration = isObject(body.configuration) ? body.configuration : {}
        const historyLength = optionalInt(configuration.historyLength, 'historyLength', 1000)
        if (configuration.returnImmediately === true) {
          void execute(record)
        } else {
          await execute(record)
        }
        sendJson(res, 200, { task: taskResponse(record, historyLength) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/message:stream') {
        if (!isObject(body)) throw new Error('请求体必须是对象')
        const record = recordForMessage(body, requestId, true)
        stream(res, record, undefined, requestId)
        void execute(record)
        return
      }
      const pushMatch = url.pathname.match(/^\/tasks\/([^/]+)\/pushNotificationConfigs(?:\/([^/]+))?$/)
      if (pushMatch) {
        const record = findRecord(decodeURIComponent(pushMatch[1]))
        const configId = pushMatch[2] ? decodeURIComponent(pushMatch[2]) : undefined
        if (req.method === 'POST' && !configId) {
          const value = isObject(body) && isObject(body.config) ? body.config : body
          sendJson(res, 200, addPushConfig(record, value, requestId))
          return
        }
        if (req.method === 'GET' && !configId) {
          sendJson(res, 200, { configs: listPushConfigs(record) })
          return
        }
        if (req.method === 'GET' && configId) {
          sendJson(res, 200, getPushConfig(record, configId))
          return
        }
        if (req.method === 'DELETE' && configId) {
          deletePushConfig(record, configId)
          sendJson(res, 200, {})
          return
        }
      }
      const taskMatch = url.pathname.match(/^\/tasks\/([^/:]+)(?::(cancel|subscribe))?$/)
      if (taskMatch) {
        const record = findRecord(decodeURIComponent(taskMatch[1]))
        if (req.method === 'GET' && !taskMatch[2]) {
          sendJson(res, 200, { task: taskResponse(record, optionalInt(url.searchParams.get('historyLength'), 'historyLength', 1000)) })
          return
        }
        if (req.method === 'POST' && taskMatch[2] === 'cancel') {
          sendJson(res, 200, { task: cancelTask(record, requestId) })
          return
        }
        if (req.method === 'POST' && taskMatch[2] === 'subscribe') {
          if (TERMINAL_STATES.has(record.task.status.state)) {
            sendError(res, 409, '终态任务不支持订阅')
            return
          }
          stream(res, record, undefined, requestId)
          return
        }
      }
      if (req.method === 'GET' && url.pathname === '/tasks') {
        sendJson(res, 200, listTasks({
          contextId: url.searchParams.get('contextId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          pageSize: url.searchParams.get('pageSize') ?? undefined,
          pageToken: url.searchParams.get('pageToken') ?? undefined,
        }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/extendedAgentCard') {
        sendJson(res, 200, agentCard(req, { ...opts, streaming: streamingEnabled, pushNotifications: pushNotificationsEnabled }))
        return
      }
      sendError(res, 404, '未找到 A2A 端点')
    } catch (error) {
      const message = (error as Error).message
      const statusCode = (error as Error & { statusCode?: number }).statusCode
      const code = statusCode ?? (error instanceof A2aLimitError ? error.statusCode : message.startsWith('Task not found') ? 404 : message.includes('不能') || message.includes('缺少') || message.includes('不能为空') || message.includes('无效') ? 400 : 500)
      sendError(res, code, message)
    }
  }) as A2aServer

  server.drainPushNotifications = async (timeoutMs = DEFAULT_PUSH_DRAIN_TIMEOUT_MS, stopOnTimeout = false): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (activeExecutions > 0 || pendingPushDeliveries.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        if (stopOnTimeout) stopPushDispatch()
        recordAudit(opts.runtimeEvents, {
          kind: 'a2a_push_drain_timeout',
          sessionId: runtimeSessionId(),
          level: 'warn',
          payload: { activeExecutions, pendingPushDeliveries: pendingPushDeliveries.size, timeoutMs },
        })
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
    }
    return true
  }

  server.on('close', () => {
    shuttingDown = true
    clearInterval(pruneTimer)
    for (const timer of pushRetryTimers.values()) clearTimeout(timer)
    pushRetryTimers.clear()
    for (const record of tasks.values()) {
      clearPendingPush(record)
      record.handle?.cancel()
    }
  })

  return server
}
