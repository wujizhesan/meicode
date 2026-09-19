import { createParser } from 'eventsource-parser'
import { withRequestTimeout } from './timeout.ts'
import {
  drainToolCalls,
  getResponseErrorDetail,
  linkAbortSignal,
  readResponseStream,
  type ToolCallAccumulator,
} from './stream.ts'
import type { ProviderConfig } from '../config/types.ts'
import type { ChatMessage, Provider, ProviderTool, StreamChatOptions, StreamEvent, ToolCallMeta } from './types.ts'
import { log } from '../log.ts'

const API_VERSION = '2023-06-01'

// 同一轮多个工具结果的合并块（Anthropic 要求 tool_use 的所有 result 在同一条消息）
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicMessage {
  role: 'assistant' | 'user'
  content: string | ToolResultBlock[] | AnthropicContentBlock[]
}

const toolInputCache = new WeakMap<ToolCallMeta, { arguments: string; input: unknown }>()

function parseToolInput(toolCall: ToolCallMeta): unknown {
  const cached = toolInputCache.get(toolCall)
  if (cached?.arguments === toolCall.arguments) return cached.input
  let input: unknown = {}
  try {
    input = JSON.parse(toolCall.arguments)
  } catch {
  }
  toolInputCache.set(toolCall, { arguments: toolCall.arguments, input })
  return input
}

export class AnthropicProvider implements Provider {
  readonly protocol = 'anthropic' as const
  private readonly cfg: ProviderConfig

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
  }

  async *streamChat(messages: ChatMessage[], opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    const thinking = opts.thinking ?? this.cfg.thinking ?? false
    const base = this.cfg.base_url.replace(/\/+$/, '')
    const endpoint = /\/messages$/i.test(base) ? base : `${base}/v1/messages`
    const request = linkAbortSignal(opts.signal)

    const body = toAnthropicBody(messages, this.cfg.model, thinking, opts.tools)

    let res: Response
    try {
      res = await withRequestTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.cfg.api_key,
            authorization: `Bearer ${this.cfg.api_key}`, // DeepSeek 兼容层认 Bearer
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
          signal: request.controller.signal,
        }),
        60000,
        request.controller,
      )
    } catch (e) {
      request.dispose()
      log('error', `anthropic 请求失败: ${(e as Error).message}`)
      yield { type: 'error', message: `网络请求失败: ${(e as Error).message}` }
      return
    }
    request.dispose()

    if (!res.ok || !res.body) {
      const detail = await getResponseErrorDetail(res)
      log('error', `anthropic API 错误: ${detail.slice(0, 300)}`)
      yield { type: 'error', message: `Anthropic API 错误: ${detail}` }
      return
    }

    const queue: StreamEvent[] = []
    let doneSent = false
    const toolAcc = new Map<number, ToolCallAccumulator>()

    const push = (event: StreamEvent) => queue.push(event)

    // message_stop 前：把累积的 tool_use 块按序发出
    const flushTools = () => {
      queue.push(...drainToolCalls(toolAcc))
    }

    const parser = createParser({
      onEvent: (event) => {
        if (!event.data) return
        let data: {
          type?: string
          index?: number
          message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }
          usage?: { output_tokens?: number }
          content_block?: { type?: string; id?: string; name?: string }
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
          error?: { message?: string }
        }
        try {
          data = JSON.parse(event.data)
        } catch {
          return
        }
        if (data.type === 'message_start' && data.message?.usage) {
          push({
            type: 'usage',
            inputTokens: data.message.usage.input_tokens ?? 0,
            outputTokens: 0,
            cacheHitTokens: data.message.usage.cache_read_input_tokens,
            cacheMissTokens: data.message.usage.cache_creation_input_tokens,
          })
        } else if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
          toolAcc.set(data.index ?? 0, { id: data.content_block.id, name: data.content_block.name, args: [] })
        } else if (data.type === 'content_block_delta') {
          const delta = data.delta
          if (delta?.type === 'text_delta') push({ type: 'text', text: delta.text ?? '' })
          else if (delta?.type === 'thinking_delta') push({ type: 'thinking', text: delta.thinking ?? '' })
          else if (delta?.type === 'input_json_delta') {
            const acc = toolAcc.get(data.index ?? 0) ?? { args: [] }
            if (delta.partial_json) acc.args.push(delta.partial_json)
            toolAcc.set(data.index ?? 0, acc)
          }
        } else if (data.type === 'message_delta' && data.usage) {
          push({
            type: 'usage',
            inputTokens: 0,
            outputTokens: data.usage.output_tokens ?? 0,
          })
        } else if (data.type === 'message_stop') {
          flushTools()
          doneSent = true
          push({ type: 'done' })
        } else if (data.type === 'error') {
          flushTools()
          doneSent = true
          push({ type: 'error', message: data.error?.message ?? '未知错误' })
        }
      },
    })

    try {
      const decoder = new TextDecoder()
      for await (const value of readResponseStream(res.body, opts.signal)) {
        parser.feed(decoder.decode(value, { stream: true }))
        for (const event of queue) yield event
        queue.length = 0
      }
    } catch (e) {
      log('error', `anthropic 流读取失败: ${(e as Error).message}`)
      yield { type: 'error', message: `流读取失败: ${(e as Error).message}` }
      return
    }

    if (!doneSent) {
      flushTools()
      push({ type: 'done' })
    }
    for (const event of queue) yield event
  }
}

// ChatMessage 历史 → Anthropic messages 格式
// - system 提取到独立 system 字段
// - assistant(tool_calls) → content blocks（text + tool_use）
// - tool 消息 → user 块 { type: tool_result, tool_use_id }
export function toAnthropicBody(
  messages: ChatMessage[],
  model: string,
  thinking: boolean,
  tools?: ProviderTool[],
): Record<string, unknown> {
  const systemParts: string[] = []
  const converted: AnthropicMessage[] = []
  let previousRole: ChatMessage['role'] | null = null
  let previousMergeable = false
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }
    const previous = converted[converted.length - 1]
    if (previous && previousRole === 'tool' && m.role === 'tool') {
      (previous.content as ToolResultBlock[]).push({ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content })
      continue
    }
    if (previous && previousRole === m.role && previousMergeable && !m.tool_calls) {
      if (m.role === 'assistant') {
        const blocks = previous.content as AnthropicContentBlock[]
        const text = `${blocks[0]?.text ?? ''}\n\n${m.content}`
        if (blocks.length === 0) blocks.push({ type: 'text', text })
        else blocks[0].text = text
      } else {
        previous.content = `${previous.content as string}\n\n${m.content}`
      }
      continue
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const toolCall of m.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: parseToolInput(toolCall) })
      }
      converted.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content }],
      })
    } else {
      converted.push({ role: 'user', content: m.content })
    }
    previousRole = m.role
    previousMergeable = !m.tool_calls
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: thinking ? 32000 : 16384,
    stream: true,
    ...(thinking ? { thinking: { type: 'enabled' as const, budget_tokens: 16000 } } : {}),
    messages: converted,
  }
  if (systemParts.length > 0) body.system = systemParts.join('\n\n')
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))
  }
  return body
}
