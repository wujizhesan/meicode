import type { A2AArtifact, A2AMessage, A2AStreamResponse, A2ATask, A2APushNotificationConfig } from '../a2a.ts'

function takeSseBlocks(buffer: string): { blocks: string[]; remainder: string } {
  const blocks: string[] = []
  let remainder = buffer
  while (true) {
    const separator = /\r?\n\r?\n/.exec(remainder)
    if (!separator) break
    blocks.push(remainder.slice(0, separator.index))
    remainder = remainder.slice(separator.index + separator[0].length)
  }
  return { blocks, remainder }
}

function sseData(block: string): string | undefined {
  const lines = block.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
  return lines.length > 0 ? lines.join('\n') : undefined
}

export interface A2aClientOptions {
  authToken?: string
  version?: '1.0' | '0.3'
  timeoutMs?: number
  binding?: 'http' | 'jsonrpc'
  fetchImpl?: typeof fetch
}

export interface A2aMessageConfiguration {
  acceptedOutputModes?: string[]
  taskPushNotificationConfig?: Omit<A2APushNotificationConfig, 'taskId'>
  historyLength?: number
  returnImmediately?: boolean
}

export class A2aClient {
  private readonly baseUrl: string
  private readonly authToken?: string
  private readonly version: string
  private readonly timeoutMs: number
  private readonly binding: 'http' | 'jsonrpc'
  private readonly fetchImpl: typeof fetch

  constructor(agentUrl: string, options: A2aClientOptions = {}) {
    const normalized = agentUrl.endsWith('/.well-known/agent-card.json') || agentUrl.endsWith('/.well-known/agent.json')
      ? new URL('/', agentUrl).toString()
      : agentUrl
    this.baseUrl = normalized.replace(/\/$/, '')
    this.authToken = options.authToken
    this.version = options.version ?? '1.0'
    this.timeoutMs = options.timeoutMs ?? 30000
    this.binding = options.binding ?? 'http'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private headers(accept = 'application/a2a+json'): Record<string, string> {
    return {
      accept,
      'content-type': 'application/a2a+json',
      'A2A-Version': this.version,
      ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
    }
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, this.timeoutMs))
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  }

  private async response(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      ...init,
      headers: { ...this.headers(init.headers && new Headers(init.headers).get('accept') === 'text/event-stream' ? 'text/event-stream' : undefined), ...(init.headers ?? {}) },
      signal: this.requestSignal(signal ?? (init.signal instanceof AbortSignal ? init.signal : undefined)),
    })
  }

  private async json<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.response(path, init, signal)
    const body = await response.json() as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `A2A 请求失败: ${response.status}`)
    return body
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.response('/', {
      method: 'POST',
      headers: { ...this.headers('application/json'), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, method, params }),
    }, signal)
    const body = await response.json() as { result?: T; error?: { message?: string } }
    if (!response.ok || body.error) throw new Error(body.error?.message ?? `A2A JSON-RPC 请求失败: ${response.status}`)
    if (body.result === undefined) throw new Error('A2A JSON-RPC 响应缺少 result')
    return body.result
  }

  private async *rpcStream(method: string, params: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    const response = await this.response('/', {
      method: 'POST',
      headers: { ...this.headers('text/event-stream'), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, method, params }),
    }, signal)
    if (!response.ok) {
      const body = await response.json() as { error?: { message?: string } }
      throw new Error(body.error?.message ?? `A2A JSON-RPC 流式请求失败: ${response.status}`)
    }
    if (!response.body) throw new Error('A2A JSON-RPC 响应没有流')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const parsed = takeSseBlocks(buffer)
        buffer = parsed.remainder
        for (const block of parsed.blocks) {
          const data = sseData(block)
          if (!data || data === '[DONE]') continue
          const event = JSON.parse(data) as { result?: A2AStreamResponse; error?: { message?: string } }
          if (event.error) throw new Error(event.error.message ?? 'A2A JSON-RPC 流式错误')
          if (event.result) yield event.result
        }
      }
      buffer += decoder.decode()
      const tail = sseData(buffer.trim())
      if (tail && tail !== '[DONE]') {
        const event = JSON.parse(tail) as { result?: A2AStreamResponse; error?: { message?: string } }
        if (event.error) throw new Error(event.error.message ?? 'A2A JSON-RPC 流式错误')
        if (event.result) yield event.result
      }
    } finally {
      reader.releaseLock()
    }
  }

  private message(input: string | A2AMessage): A2AMessage {
    if (typeof input !== 'string') return input
    return {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'ROLE_USER',
      parts: [{ kind: 'text', text: input }],
    }
  }

  async getAgentCard(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>('/.well-known/agent-card.json', { method: 'GET' }, signal)
  }

  async sendMessage(input: string | A2AMessage, configuration?: A2aMessageConfiguration, signal?: AbortSignal): Promise<A2ATask> {
    const params = { message: this.message(input), ...(configuration ? { configuration } : {}) }
    const result = this.binding === 'jsonrpc'
      ? await this.rpc<{ task: A2ATask }>('SendMessage', params, signal)
      : await this.json<{ task: A2ATask }>('/message:send', { method: 'POST', body: JSON.stringify(params) }, signal)
    return result.task
  }

  async *streamMessage(input: string | A2AMessage, configuration?: Omit<A2aMessageConfiguration, 'returnImmediately'>, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse> {
    const params = { message: this.message(input), ...(configuration ? { configuration } : {}) }
    if (this.binding === 'jsonrpc') {
      yield* this.rpcStream('SendStreamingMessage', params, signal)
      return
    }
    const response = await this.response('/message:stream', {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: JSON.stringify(params),
    }, signal)
    if (!response.ok) {
      const body = await response.json() as { error?: { message?: string } }
      throw new Error(body.error?.message ?? `A2A 流式请求失败: ${response.status}`)
    }
    if (!response.body) throw new Error('A2A 响应没有流')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const parsed = takeSseBlocks(buffer)
        buffer = parsed.remainder
        for (const block of parsed.blocks) {
          const data = sseData(block)
          if (data && data !== '[DONE]') yield JSON.parse(data) as A2AStreamResponse
        }
      }
      buffer += decoder.decode()
      const tail = sseData(buffer.trim())
      if (tail && tail !== '[DONE]') yield JSON.parse(tail) as A2AStreamResponse
    } finally {
      reader.releaseLock()
    }
  }

  async getTask(taskId: string, historyLength?: number, signal?: AbortSignal): Promise<A2ATask> {
    const suffix = historyLength === undefined ? '' : `?historyLength=${encodeURIComponent(String(historyLength))}`
    const result = this.binding === 'jsonrpc'
      ? await this.rpc<{ task: A2ATask }>('GetTask', { id: taskId, ...(historyLength === undefined ? {} : { historyLength }) }, signal)
      : await this.json<{ task: A2ATask }>(`/tasks/${encodeURIComponent(taskId)}${suffix}`, { method: 'GET' }, signal)
    return result.task
  }

  async listTasks(options: { contextId?: string; status?: string; pageSize?: number; pageToken?: string } = {}, signal?: AbortSignal): Promise<{ tasks: A2ATask[]; totalSize: number; nextPageToken?: string }> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value))
    const result = this.binding === 'jsonrpc'
      ? await this.rpc<{ tasks: A2ATask[]; totalSize: number; nextPageToken?: string }>('ListTasks', options as Record<string, unknown>, signal)
      : await this.json<{ tasks: A2ATask[]; totalSize: number; nextPageToken?: string }>(`/tasks${query.size ? `?${query}` : ''}`, { method: 'GET' }, signal)
    return result
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<A2ATask> {
    const result = this.binding === 'jsonrpc'
      ? await this.rpc<{ task: A2ATask }>('CancelTask', { id: taskId }, signal)
      : await this.json<{ task: A2ATask }>(`/tasks/${encodeURIComponent(taskId)}:cancel`, { method: 'POST', body: '{}' }, signal)
    return result.task
  }

  async createPushNotificationConfig(taskId: string, config: Omit<A2APushNotificationConfig, 'id' | 'taskId'>, signal?: AbortSignal): Promise<A2APushNotificationConfig> {
    if (this.binding === 'jsonrpc') {
      const result = await this.rpc<{ config: A2APushNotificationConfig }>('CreateTaskPushNotificationConfig', { taskId, config }, signal)
      return result.config
    }
    return this.json<A2APushNotificationConfig>(`/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`, { method: 'POST', body: JSON.stringify(config) }, signal)
  }

  async listPushNotificationConfigs(taskId: string, signal?: AbortSignal): Promise<A2APushNotificationConfig[]> {
    const result = this.binding === 'jsonrpc'
      ? await this.rpc<{ configs: A2APushNotificationConfig[] }>('ListTaskPushNotificationConfigs', { taskId }, signal)
      : await this.json<{ configs: A2APushNotificationConfig[] }>(`/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`, { method: 'GET' }, signal)
    return result.configs
  }

  async getPushNotificationConfig(taskId: string, configId: string, signal?: AbortSignal): Promise<A2APushNotificationConfig> {
    if (this.binding === 'jsonrpc') {
      const result = await this.rpc<{ config: A2APushNotificationConfig }>('GetTaskPushNotificationConfig', { taskId, configId }, signal)
      return result.config
    }
    return this.json<A2APushNotificationConfig>(`/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs/${encodeURIComponent(configId)}`, { method: 'GET' }, signal)
  }

  async deletePushNotificationConfig(taskId: string, configId: string, signal?: AbortSignal): Promise<void> {
    if (this.binding === 'jsonrpc') {
      await this.rpc<Record<string, never>>('DeleteTaskPushNotificationConfig', { taskId, configId }, signal)
      return
    }
    await this.json<Record<string, never>>(`/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs/${encodeURIComponent(configId)}`, { method: 'DELETE' }, signal)
  }
}
