import { createRuntimeId } from '../runtime/index.ts'
import type { A2AMessage, A2APart, A2APushNotificationConfig, TaskState } from './types.ts'

const MAX_TEXT_LENGTH = 200_000
export const MAX_ID_LENGTH = 128

export const MAX_BODY_BYTES = 2 * 1024 * 1024
export const DEFAULT_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TERMINAL_STATES = new Set<TaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
])
export const TASK_STATES = new Set<TaskState>([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
])

export interface RpcRequest {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: unknown
}

export class A2aLimitError extends Error {
  readonly statusCode = 429
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function textMessage(text: string, role: A2AMessage['role'], contextId?: string, taskId?: string): A2AMessage {
  return {
    messageId: createRuntimeId('message'),
    role,
    parts: [{ kind: 'text', text }],
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
  }
}

export function firstText(message: A2AMessage): string {
  return message.parts.map((part) => part.text).join('\n').trim()
}

export function now(): string {
  return new Date().toISOString()
}

export function optionalInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${name} 无效`)
  return parsed
}

export function normalizePushAllowedUrls(values: readonly string[]): ReadonlySet<string> {
  const allowed = new Set<string>()
  for (const value of values) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('A2A Push 允许地址无效')
    }
    if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
      throw new Error('A2A Push 允许地址必须为 HTTPS，或显式指定本机 HTTP')
    }
    allowed.add(parsed.toString())
  }
  return allowed
}

export function normalizePushNotificationConfig(value: unknown, taskId: string, allowedUrls: ReadonlySet<string> = new Set()): A2APushNotificationConfig {
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
  if (!allowedUrls.has(parsed.toString())) throw new Error('Push Notification URL 无效：未列入允许列表')
  const id = typeof value.id === 'string' && value.id ? value.id : createRuntimeId('event')
  if (id.length > MAX_ID_LENGTH || /[\0\r\n]/.test(id)) throw new Error('Push Notification id 无效')
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
    id,
    taskId,
    url: parsed.toString(),
    ...(token ? { token } : {}),
    ...(authentication ? { authentication } : {}),
  }
}

export function parseMessage(value: unknown): A2AMessage {
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
  for (const [name, current] of [['messageId', value.messageId], ['contextId', value.contextId], ['taskId', value.taskId]] as const) {
    if (current !== undefined && (typeof current !== 'string' || current.length === 0 || current.length > MAX_ID_LENGTH || /[\0\r\n]/.test(current))) {
      throw new Error(`${name} 无效`)
    }
  }
  return {
    messageId: typeof value.messageId === 'string' && value.messageId ? value.messageId : createRuntimeId('message'),
    role: 'ROLE_USER',
    parts,
    ...(typeof value.contextId === 'string' ? { contextId: value.contextId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
  }
}

export function rpcRequest(body: unknown): { request: RpcRequest; params: Record<string, unknown>; id: string | number | null } {
  if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') throw new Error('无效 JSON-RPC 请求')
  if (body.id !== null && typeof body.id !== 'string' && typeof body.id !== 'number') throw new Error('无效 JSON-RPC id')
  if (typeof body.id === 'string' && body.id.length > MAX_ID_LENGTH) throw new Error('无效 JSON-RPC id')
  return { request: body as RpcRequest, params: isObject(body.params) ? body.params : {}, id: (body.id ?? null) as string | number | null }
}

const METHOD_NAMES: Record<string, string> = {
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
}

export function methodName(method: string): string {
  return METHOD_NAMES[method] ?? ''
}
