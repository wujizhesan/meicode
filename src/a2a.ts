import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from './provider/types.ts'
import { History } from './session/history.ts'
import type { ToolContext, ToolRegistry } from './tools/index.ts'
import type { RuleEngine } from './permission/index.ts'
import { runAgent } from './agent/loop.ts'
import { buildPrompt } from './agent/prompt/index.ts'
import { createRuntimeId, recordAudit } from './runtime/index.ts'
import type { RuntimeEventLog } from './runtime/index.ts'
import { atomicWriteFile } from './team/atomic.ts'
import { withLock } from './team/lock.ts'

type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'

export interface A2APart {
  kind: 'text'
  text: string
}

export interface A2AMessage {
  messageId: string
  role: 'ROLE_USER' | 'ROLE_AGENT'
  parts: A2APart[]
  contextId?: string
  taskId?: string
}

export interface A2AStatus {
  state: TaskState
  timestamp: string
  message?: A2AMessage
}

export interface A2AArtifact {
  artifactId: string
  name?: string
  parts: A2APart[]
}

export interface A2ATask {
  id: string
  contextId: string
  status: A2AStatus
  history: A2AMessage[]
  artifacts: A2AArtifact[]
}

export interface A2AStreamResponse {
  task?: A2ATask
  statusUpdate?: { taskId: string; contextId: string; status: A2AStatus; final?: boolean }
  artifactUpdate?: { taskId: string; contextId: string; artifact: A2AArtifact; append: boolean; lastChunk: boolean }
}

export interface A2APushNotificationConfig {
  id: string
  taskId: string
  url: string
  token?: string
  authentication?: { scheme: string; credentials: string }
}

interface A2AStoredTask {
  task: A2ATask
  pushNotificationConfigs: A2APushNotificationConfig[]
}

interface A2ATaskRecord {
  task: A2ATask
  history: History
  handle?: ReturnType<typeof runAgent>
  events: A2AStreamResponse[]
  listeners: Set<(event: A2AStreamResponse) => void>
  started: boolean
  canceled: boolean
  pushNotificationConfigs: Map<string, A2APushNotificationConfig>
  pushQueue: Promise<void>
  requestId?: string
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
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
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
      const backup = `${this.file}.corrupt.${Date.now()}.json`
      try {
        renameSync(this.file, backup)
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

interface RpcRequest {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: unknown
}

export interface A2aOptions {
  provider: Provider
  registry: ToolRegistry
  engine: RuleEngine
  cwd: string
  memoryTail?: string
  baseUrl?: string
  authToken?: string
  taskRoot?: string
  taskStore?: A2aTaskStore
  maxTasks?: number
  taskTtlMs?: number
  maxConcurrentTasks?: number
  runtimeEvents?: RuntimeEventLog
  sessionId?: string
  name?: string
  description?: string
}

const TERMINAL_STATES = new Set<TaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
])
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_TEXT_LENGTH = 200_000
const DEFAULT_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TASK_STATES = new Set<TaskState>([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isPersistedTask(value: unknown): value is A2ATask {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.contextId !== 'string') return false
  if (!isObject(value.status) || typeof value.status.timestamp !== 'string' || typeof value.status.state !== 'string' || !TASK_STATES.has(value.status.state as TaskState)) return false
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

function textMessage(text: string, role: A2AMessage['role'], contextId?: string, taskId?: string): A2AMessage {
  return {
    messageId: createRuntimeId('message'),
    role,
    parts: [{ kind: 'text', text }],
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
  }
}

function firstText(message: A2AMessage): string {
  return message.parts.map((part) => part.text).join('\n').trim()
}

function stateMessage(record: A2ATaskRecord, text: string): A2AMessage {
  return textMessage(text, 'ROLE_AGENT', record.task.contextId, record.task.id)
}

function now(): string {
  return new Date().toISOString()
}

function optionalInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${name} 无效`)
  return parsed
}

function normalizePushNotificationConfig(value: unknown, taskId: string): A2APushNotificationConfig {
  if (!isObject(value) || typeof value.url !== 'string' || value.url.length > 2048) throw new Error('Push Notification url 无效')
  let parsed: URL
  try {
    parsed = new URL(value.url)
  } catch {
    throw new Error('Push Notification url 无效')
  }
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
    throw new Error('Push Notification 只允许 HTTPS，HTTP 仅限本机')
  }
  const token = value.token === undefined ? undefined : String(value.token)
  if (token && (token.length > 1024 || /[\r\n]/.test(token))) throw new Error('Push Notification token 无效')
  let authentication: A2APushNotificationConfig['authentication']
  if (value.authentication !== undefined) {
    if (!isObject(value.authentication) || typeof value.authentication.scheme !== 'string' || typeof value.authentication.credentials !== 'string') {
      throw new Error('Push Notification authentication 无效')
    }
    if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(value.authentication.scheme) || value.authentication.credentials.length > 2048 || /[\r\n]/.test(value.authentication.credentials)) {
      throw new Error('Push Notification authentication 无效')
    }
    authentication = { scheme: value.authentication.scheme, credentials: value.authentication.credentials }
  }
  return {
    id: typeof value.id === 'string' && value.id ? value.id : createRuntimeId('event'),
    taskId,
    url: parsed.toString(),
    ...(token ? { token } : {}),
    ...(authentication ? { authentication } : {}),
  }
}

function parseMessage(value: unknown): A2AMessage {
  if (!isObject(value)) throw new Error('message 必须是对象')
  const role = value.role
  if (role !== undefined && role !== 'ROLE_USER' && role !== 'user') throw new Error('只接受 ROLE_USER 消息')
  if (!Array.isArray(value.parts) || value.parts.length === 0) throw new Error('message.parts 不能为空')
  const parts: A2APart[] = []
  for (const part of value.parts) {
    if (!isObject(part) || typeof part.text !== 'string') throw new Error('当前只支持 text part')
    if (part.text.length > MAX_TEXT_LENGTH) throw new Error('message.text 超出长度限制')
    parts.push({ kind: 'text', text: part.text })
  }
  if (!parts.some((part) => part.text.trim())) throw new Error('message.parts 不能全为空')
  return {
    messageId: typeof value.messageId === 'string' && value.messageId ? value.messageId : createRuntimeId('message'),
    role: 'ROLE_USER',
    parts,
    ...(typeof value.contextId === 'string' ? { contextId: value.contextId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
  }
}

class A2aLimitError extends Error {
  readonly statusCode = 429
}

export function createA2aServer(opts: A2aOptions): ReturnType<typeof createServer> {
  const tasks = new Map<string, A2ATaskRecord>()
  const taskStore = opts.taskStore ?? (opts.taskRoot ? new A2aTaskStore(opts.taskRoot) : undefined)
  const maxTasks = opts.maxTasks ?? 1000
  const taskTtlMs = opts.taskTtlMs ?? DEFAULT_TASK_TTL_MS
  const maxConcurrentTasks = opts.maxConcurrentTasks ?? 4
  let activeExecutions = 0

  const persist = (record: A2ATaskRecord): void => {
    taskStore?.save(record.task, [...record.pushNotificationConfigs.values()])
  }

  const taskResponse = (record: A2ATaskRecord, historyLength?: number): A2ATask => {
    const task = clone(record.task)
    if (historyLength !== undefined) task.history = historyLength === 0 ? [] : task.history.slice(-historyLength)
    return task
  }

  const pruneTasks = (): void => {
    if (taskTtlMs <= 0) return
    const cutoff = Date.now() - taskTtlMs
    for (const [id, record] of tasks) {
      if (!TERMINAL_STATES.has(record.task.status.state)) continue
      const timestamp = Date.parse(record.task.status.timestamp)
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        tasks.delete(id)
        taskStore?.remove(id)
      }
    }
  }

  const listTasks = (filters: { contextId?: unknown; status?: unknown; pageSize?: unknown; pageToken?: unknown }): { tasks: A2ATask[]; totalSize: number; nextPageToken?: string } => {
    pruneTasks()
    const contextId = filters.contextId === undefined ? undefined : String(filters.contextId)
    const status = filters.status === undefined ? undefined : String(filters.status)
    if (status && !TASK_STATES.has(status as TaskState)) throw new Error('status 无效')
    const filtered = [...tasks.values()]
      .filter((record) => !contextId || record.task.contextId === contextId)
      .filter((record) => !status || record.task.status.state === status)
    const pageSize = optionalInt(filters.pageSize, 'pageSize', 100) ?? 50
    if (pageSize === 0) throw new Error('pageSize 无效')
    const token = filters.pageToken === undefined || filters.pageToken === '' ? 0 : Number(Buffer.from(String(filters.pageToken), 'base64url').toString('utf8'))
    if (!Number.isInteger(token) || token < 0 || token > filtered.length) throw new Error('pageToken 无效')
    const page = filtered.slice(token, token + pageSize).map((record) => clone(record.task))
    const next = token + page.length < filtered.length ? Buffer.from(String(token + page.length)).toString('base64url') : undefined
    return { tasks: page, totalSize: filtered.length, ...(next ? { nextPageToken: next } : {}) }
  }

  const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
    if (res.writableEnded) return
    res.writeHead(code, { 'content-type': 'application/a2a+json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const sendError = (res: ServerResponse, code: number, message: string, rpcId?: string | number | null, rpcCode?: number): void => {
    if (rpcId !== undefined) {
      sendJson(res, code, { jsonrpc: '2.0', id: rpcId, error: { code: rpcCode ?? -32000, message } })
      return
    }
    sendJson(res, code, { error: { code, status: message.toUpperCase().replaceAll(' ', '_'), message } })
  }

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let raw = ''
      let size = 0
      req.on('data', (chunk: Buffer | string) => {
        size += Buffer.byteLength(chunk)
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        raw += chunk.toString()
      })
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          reject(new Error('JSON 解析失败'))
        }
      })
      req.on('error', reject)
    })

  const baseUrl = (req: IncomingMessage): string => {
    if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, '')
    const host = req.headers.host ?? '127.0.0.1'
    return `http://${host}`
  }

  const agentCard = (req: IncomingMessage): Record<string, unknown> => ({
    name: opts.name ?? 'MeiCode Agent',
    description: opts.description ?? 'MeiCode coding agent with tool execution and task streaming.',
    supportedInterfaces: [
      { url: `${baseUrl(req)}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${baseUrl(req)}`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ],
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: false },
    defaultInputModes: ['text/plain', 'application/a2a+json'],
    defaultOutputModes: ['text/plain', 'application/a2a+json'],
    skills: [{
      id: 'meicode-coding-agent',
      name: 'MeiCode coding agent',
      description: '分析、修改、测试和验证代码项目。',
      tags: ['coding', 'debugging', 'testing'],
    }],
    ...(opts.authToken ? {
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'opaque' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    } : {}),
    version: '0.1.0',
  })

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (!opts.authToken) return true
    return req.headers.authorization === `Bearer ${opts.authToken}`
  }

  const deliverPush = async (record: A2ATaskRecord, event: A2AStreamResponse): Promise<void> => {
    if (record.pushNotificationConfigs.size === 0) return
    for (const config of record.pushNotificationConfigs.values()) {
      let delivered = false
      let lastError = '投递失败'
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        try {
          const headers: Record<string, string> = { 'content-type': 'application/a2a+json' }
          if (config.token) headers['X-A2A-Notification-Token'] = config.token
          if (config.authentication) headers.authorization = `${config.authentication.scheme} ${config.authentication.credentials}`
          const response = await fetch(config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(event),
            signal: controller.signal,
          })
          if (response.ok) {
            delivered = true
            break
          }
          lastError = `HTTP ${response.status}`
        } catch (error) {
          lastError = (error as Error).message
        } finally {
          clearTimeout(timer)
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!delivered) {
        let target = 'unknown'
        try { target = new URL(config.url).host } catch { }
        recordAudit(opts.runtimeEvents, { kind: 'a2a_push_failed', sessionId: opts.sessionId ?? record.task.contextId, taskId: record.task.id, level: 'warn', payload: { target, error: lastError, eventType: Object.keys(event)[0] ?? 'unknown' } })
      }
    }
  }

  const notify = (record: A2ATaskRecord, event: A2AStreamResponse): void => {
    record.events.push(clone(event))
    if (record.events.length > 1000) record.events.shift()
    for (const listener of record.listeners) listener(clone(event))
    record.pushQueue = record.pushQueue.then(() => deliverPush(record, event)).catch(() => undefined)
  }

  const setStatus = (record: A2ATaskRecord, state: TaskState, message?: string, final = false): void => {
    record.task.status = {
      state,
      timestamp: now(),
      ...(message ? { message: stateMessage(record, message) } : {}),
    }
    notify(record, { statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: clone(record.task.status), final } })
    persist(record)
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
      started: false,
      canceled: false,
      pushNotificationConfigs: new Map(pushNotificationConfig ? [[pushNotificationConfig.id, { ...pushNotificationConfig, taskId: task.id }]] : []),
      pushQueue: Promise.resolve(),
      requestId,
    }
    record.history.push({ role: 'user', content: firstText(message) })
    tasks.set(task.id, record)
    recordAudit(opts.runtimeEvents, { kind: 'a2a_task_created', sessionId: opts.sessionId ?? task.contextId, taskId: task.id, requestId, payload: { protocol: 'a2a' } })
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
    return { task, history, events: [], listeners: new Set(), started: false, canceled: false, pushNotificationConfigs: new Map(), pushQueue: Promise.resolve() }
  }

  for (const stored of taskStore?.load() ?? []) {
    const record = restoreRecord(stored.task)
    for (const config of stored.pushNotificationConfigs) record.pushNotificationConfigs.set(config.id, config)
    tasks.set(stored.task.id, record)
    if (stored.task.status.state === 'TASK_STATE_SUBMITTED' || stored.task.status.state === 'TASK_STATE_WORKING') {
      setStatus(record, 'TASK_STATE_FAILED', '服务重启，任务未完成', true)
    }
  }
  pruneTasks()
  const pruneTimer = setInterval(pruneTasks, Math.min(Math.max(taskTtlMs, 60_000), 60 * 60 * 1000))
  pruneTimer.unref?.()

  const findRecord = (id: unknown): A2ATaskRecord => {
    pruneTasks()
    if (typeof id !== 'string' || !id) throw new Error('缺少 task id')
    const record = tasks.get(id)
    if (!record) throw new Error(`Task not found: ${id}`)
    return record
  }

  const recordForMessage = (body: Record<string, unknown>, requestId?: string): A2ATaskRecord => {
    pruneTasks()
    const message = parseMessage(body.message)
    const configuration = body.configuration
    const pushConfigValue = isObject(configuration) ? configuration.taskPushNotificationConfig : undefined
    if (configuration !== undefined && !isObject(configuration)) throw new Error('configuration 必须是对象')
    const pushConfig = pushConfigValue === undefined ? undefined : normalizePushNotificationConfig(pushConfigValue, '')
    const taskId = message.taskId ?? (typeof body.taskId === 'string' ? body.taskId : undefined)
    const existingByMessageId = [...tasks.values()].find((item) => item.task.history.some((entry) => entry.messageId === message.messageId))
    if (existingByMessageId) {
      if (taskId && taskId !== existingByMessageId.task.id) throw new Error('messageId 已用于其他任务')
      if (pushConfig) {
        pushConfig.taskId = existingByMessageId.task.id
        existingByMessageId.pushNotificationConfigs.set(pushConfig.id, pushConfig)
        persist(existingByMessageId)
      }
      return existingByMessageId
    }
    if (taskId) {
      const record = findRecord(taskId)
      if (record.started || TERMINAL_STATES.has(record.task.status.state)) throw new Error('任务已开始或已结束，不能继续发送消息')
      message.taskId = record.task.id
      message.contextId = record.task.contextId
      record.task.history.push(message)
      record.history.push({ role: 'user', content: firstText(message) })
      if (pushConfig) {
        pushConfig.taskId = record.task.id
        record.pushNotificationConfigs.set(pushConfig.id, pushConfig)
        persist(record)
      }
      return record
    }
    if (tasks.size >= maxTasks) {
      recordAudit(opts.runtimeEvents, { kind: 'a2a_quota_rejected', sessionId: opts.sessionId ?? 'a2a', requestId, level: 'warn', payload: { maxTasks } })
      throw new A2aLimitError('任务数量已达上限')
    }
    return newRecord(message, pushConfig, requestId)
  }

  const execute = async (record: A2ATaskRecord): Promise<void> => {
    if (record.started) return
    record.started = true
    if (activeExecutions >= maxConcurrentTasks) {
      setStatus(record, 'TASK_STATE_FAILED', '并发任务数量已达上限', true)
      recordAudit(opts.runtimeEvents, { kind: 'a2a_concurrency_rejected', sessionId: opts.sessionId ?? record.task.contextId, taskId: record.task.id, requestId: record.requestId, level: 'warn', payload: { activeExecutions, maxConcurrentTasks } })
      return
    }
    activeExecutions++
    const agentId = createRuntimeId('agent')
    const startedAt = Date.now()
    recordAudit(opts.runtimeEvents, { kind: 'a2a_task_started', sessionId: opts.sessionId ?? record.task.contextId, agentId, taskId: record.task.id, requestId: record.requestId, payload: { protocol: 'a2a' } })
    setStatus(record, 'TASK_STATE_WORKING', '任务执行中')
    const ctx: ToolContext = {
      cwd: opts.cwd,
      sessionId: record.task.contextId,
      agentId,
      taskId: record.task.id,
      runtimeEvents: opts.runtimeEvents,
      timeoutMs: 30000,
      permission: { mode: 'permissive', engine: opts.engine, autoAcceptEdits: true },
    }
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
        recordAudit(opts.runtimeEvents, { kind: 'a2a_task_finished', sessionId: opts.sessionId ?? record.task.contextId, agentId, taskId: record.task.id, requestId: record.requestId, payload: { durationMs: Date.now() - startedAt, status: 'canceled', reason: 'cancelled' } })
        return
      }
      if (result.reason === 'complete') {
        if (result.finalText) {
          const artifact: A2AArtifact = { artifactId: createRuntimeId('report'), name: 'response.txt', parts: [{ kind: 'text', text: result.finalText }] }
          record.task.artifacts.push(artifact)
          record.task.history.push(textMessage(result.finalText, 'ROLE_AGENT', record.task.contextId, record.task.id))
          notify(record, { artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId, artifact: clone(artifact), append: false, lastChunk: true } })
          persist(record)
        }
        setStatus(record, 'TASK_STATE_COMPLETED', undefined, true)
        recordAudit(opts.runtimeEvents, { kind: 'a2a_task_finished', sessionId: opts.sessionId ?? record.task.contextId, agentId, taskId: record.task.id, requestId: record.requestId, payload: { durationMs: Date.now() - startedAt, status: 'completed', reason: result.reason, totalTokens: result.totalTokens } })
      } else {
        setStatus(record, 'TASK_STATE_FAILED', result.errorMessage ?? `Agent stopped: ${result.reason}`, true)
        recordAudit(opts.runtimeEvents, { kind: 'a2a_task_finished', sessionId: opts.sessionId ?? record.task.contextId, agentId, taskId: record.task.id, requestId: record.requestId, level: 'warn', payload: { durationMs: Date.now() - startedAt, status: 'failed', reason: result.reason, error: result.errorMessage ?? '' } })
      }
    } catch (error) {
      if (!record.canceled) setStatus(record, 'TASK_STATE_FAILED', (error as Error).message, true)
      recordAudit(opts.runtimeEvents, { kind: 'a2a_task_failed', sessionId: opts.sessionId ?? record.task.contextId, agentId, taskId: record.task.id, requestId: record.requestId, level: 'error', payload: { durationMs: Date.now() - startedAt, error: (error as Error).message } })
    } finally {
      record.handle = undefined
      activeExecutions = Math.max(0, activeExecutions - 1)
      for (const listener of record.listeners) {
        if (TERMINAL_STATES.has(record.task.status.state)) listener({ task: clone(record.task) })
      }
    }
  }

  const stream = (req: IncomingMessage, res: ServerResponse, record: A2ATaskRecord, rpcId?: string | number | null): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const write = (event: A2AStreamResponse): void => {
      if (!res.writableEnded) {
        const payload = rpcId === undefined ? event : { jsonrpc: '2.0', id: rpcId, result: event }
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
        const terminal = Boolean(event.statusUpdate?.final) || Boolean(event.task && TERMINAL_STATES.has(event.task.status.state))
        if (terminal) {
          record.listeners.delete(write)
          res.end()
        }
      }
    }
    for (const event of record.events) write(event)
    if (TERMINAL_STATES.has(record.task.status.state)) {
      res.end()
      return
    }
    record.listeners.add(write)
    const close = (): void => {
      record.listeners.delete(write)
      if (!res.writableEnded) res.end()
    }
    req.on('close', close)
  }

  const rpcRequest = (body: unknown): { request: RpcRequest; params: Record<string, unknown>; id: string | number | null } => {
    if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') throw new Error('无效 JSON-RPC 请求')
    if (body.id !== null && typeof body.id !== 'string' && typeof body.id !== 'number') throw new Error('无效 JSON-RPC id')
    return { request: body as RpcRequest, params: isObject(body.params) ? body.params : {}, id: (body.id ?? null) as string | number | null }
  }

  const methodName = (method: string): string => ({
    SendMessage: 'send',
    'message/send': 'send',
    SendStreamingMessage: 'stream',
    'message/stream': 'stream',
    GetTask: 'get',
    'tasks/get': 'get',
    ListTasks: 'list',
    'tasks/list': 'list',
    CancelTask: 'cancel',
    'tasks/cancel': 'cancel',
    SubscribeToTask: 'subscribe',
    'tasks/subscribe': 'subscribe',
    CreateTaskPushNotificationConfig: 'push_create',
    GetTaskPushNotificationConfig: 'push_get',
    ListTaskPushNotificationConfigs: 'push_list',
    DeleteTaskPushNotificationConfig: 'push_delete',
  }[method] ?? '')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const requestHeader = req.headers['x-request-id']
    const requestId = typeof requestHeader === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestHeader) ? requestHeader : createRuntimeId('request')
    res.setHeader('x-request-id', requestId)
    if (!isAuthorized(req)) {
      recordAudit(opts.runtimeEvents, { kind: 'a2a_auth_rejected', sessionId: opts.sessionId ?? 'a2a', requestId, level: 'warn', payload: { method: req.method, path: url.pathname } })
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
        sendJson(res, 200, agentCard(req))
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, tasks: tasks.size })
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
          const record = recordForMessage(params, requestId)
          if (mapped === 'stream') {
            stream(req, res, record, id)
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
          record.canceled = true
          record.handle?.cancel()
          recordAudit(opts.runtimeEvents, { kind: 'a2a_cancel_requested', sessionId: opts.sessionId ?? record.task.contextId, taskId: record.task.id, requestId, payload: { status: record.task.status.state } })
          if (!TERMINAL_STATES.has(record.task.status.state)) setStatus(record, 'TASK_STATE_CANCELED', '任务已取消', true)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { task: clone(record.task) } })
          return
        }
        if (mapped === 'push_create') {
          const taskId = typeof params.taskId === 'string' ? params.taskId : typeof params.id === 'string' ? params.id : ''
          const record = findRecord(taskId)
          const config = normalizePushNotificationConfig(isObject(params.config) ? params.config : params, record.task.id)
          record.pushNotificationConfigs.set(config.id, config)
          persist(record)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { config } })
          return
        }
        if (mapped === 'push_get' || mapped === 'push_delete') {
          const taskId = typeof params.taskId === 'string' ? params.taskId : ''
          const record = findRecord(taskId)
          const configId = typeof params.configId === 'string' ? params.configId : typeof params.id === 'string' ? params.id : ''
          const config = record.pushNotificationConfigs.get(configId)
          if (!config) throw new Error(`Push Notification config not found: ${configId}`)
          if (mapped === 'push_delete') {
            record.pushNotificationConfigs.delete(configId)
            persist(record)
            sendJson(res, 200, { jsonrpc: '2.0', id, result: {} })
          } else {
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { config: clone(config) } })
          }
          return
        }
        if (mapped === 'push_list') {
          const record = findRecord(params.taskId)
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { configs: [...record.pushNotificationConfigs.values()].map((config) => clone(config)) } })
          return
        }
        const record = findRecord(params.id)
        if (TERMINAL_STATES.has(record.task.status.state)) {
          sendError(res, 409, '终态任务不支持订阅', id, -32003)
          return
        }
        stream(req, res, record, id)
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
        const record = recordForMessage(body, requestId)
        stream(req, res, record)
        void execute(record)
        return
      }
      const pushMatch = url.pathname.match(/^\/tasks\/([^/]+)\/pushNotificationConfigs(?:\/([^/]+))?$/)
      if (pushMatch) {
        const record = findRecord(decodeURIComponent(pushMatch[1]))
        const configId = pushMatch[2] ? decodeURIComponent(pushMatch[2]) : undefined
        if (req.method === 'POST' && !configId) {
          const value = isObject(body) && isObject(body.config) ? body.config : body
          const config = normalizePushNotificationConfig(value, record.task.id)
          record.pushNotificationConfigs.set(config.id, config)
          persist(record)
          sendJson(res, 200, config)
          return
        }
        if (req.method === 'GET' && !configId) {
          sendJson(res, 200, { configs: [...record.pushNotificationConfigs.values()].map((config) => clone(config)) })
          return
        }
        if (req.method === 'GET' && configId) {
          const config = record.pushNotificationConfigs.get(configId)
          if (!config) throw new Error(`Push Notification config not found: ${configId}`)
          sendJson(res, 200, config)
          return
        }
        if (req.method === 'DELETE' && configId) {
          record.pushNotificationConfigs.delete(configId)
          persist(record)
          sendJson(res, 200, {})
          return
        }
      }
      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)(?::(cancel|subscribe))?$/)
      if (taskMatch) {
        const record = findRecord(decodeURIComponent(taskMatch[1]))
        if (req.method === 'GET' && !taskMatch[2]) {
          sendJson(res, 200, { task: taskResponse(record, optionalInt(url.searchParams.get('historyLength'), 'historyLength', 1000)) })
          return
        }
        if (req.method === 'POST' && taskMatch[2] === 'cancel') {
          record.canceled = true
          record.handle?.cancel()
          recordAudit(opts.runtimeEvents, { kind: 'a2a_cancel_requested', sessionId: opts.sessionId ?? record.task.contextId, taskId: record.task.id, requestId, payload: { status: record.task.status.state } })
          if (!TERMINAL_STATES.has(record.task.status.state)) setStatus(record, 'TASK_STATE_CANCELED', '任务已取消', true)
          sendJson(res, 200, { task: clone(record.task) })
          return
        }
        if (req.method === 'POST' && taskMatch[2] === 'subscribe') {
          if (TERMINAL_STATES.has(record.task.status.state)) {
            sendError(res, 409, '终态任务不支持订阅')
            return
          }
          stream(req, res, record)
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
        sendJson(res, 200, agentCard(req))
        return
      }
      sendError(res, 404, '未找到 A2A 端点')
    } catch (error) {
      const message = (error as Error).message
      const code = error instanceof A2aLimitError ? error.statusCode : message.startsWith('Task not found') ? 404 : message.includes('不能') || message.includes('缺少') || message.includes('不能为空') ? 400 : 500
      sendError(res, code, message)
    }
  })

  server.on('close', () => {
    clearInterval(pruneTimer)
    for (const record of tasks.values()) record.handle?.cancel()
    activeExecutions = 0
  })

  return server
}
