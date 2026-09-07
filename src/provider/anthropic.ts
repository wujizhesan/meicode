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
  const merged: { role: string; content: string | ToolResultBlock[]; tool_calls?: ToolCallMeta[]; tool_call_id?: string }[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }
    const prev = merged[merged.length - 1]
    // 同一轮连续 tool 消息：合并成 tool_result 数组——Anthropic 要求一个 assistant(tool_use)
    // 的所有 result 在"下一条消息"里，分开成多条会报 tool_use without tool_result
    if (prev && prev.role === 'tool' && m.role === 'tool') {
      if (Array.isArray(prev.content)) {
        prev.content.push({ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content })
      } else {
        prev.content = [
          { type: 'tool_result', tool_use_id: prev.tool_call_id ?? '', content: prev.content },
          { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content },
        ]
      }
      continue
    }
    // 连续同角色合并（流中断后可能出现连续 user）；带 tool_calls 的不合并（保持配对）
    if (prev && prev.role === m.role && !prev.tool_calls && !m.tool_calls) {
      prev.content += '\n\n' + m.content
    } else {
      merged.push({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id })
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: thinking ? 32000 : 16384,
    stream: true,
    ...(thinking ? { thinking: { type: 'enabled' as const, budget_tokens: 16000 } } : {}),
    messages: merged.map((m) => {
      if (m.role === 'assistant') {
        const blocks: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] = []
        if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.tool_calls ?? []) {
          let input: unknown = {}
          try {
            input = JSON.parse(tc.arguments)
          } catch {
            // 参数解析失败保持空对象
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
        }
        return { role: 'assistant', content: blocks }
      }
      if (m.role === 'tool') {
        // 单条 tool_result 或合并后的 tool_result 数组（同一轮所有 result 一条消息）
        const content = Array.isArray(m.content)
          ? m.content
          : [{ type: 'tool_result' as const, tool_use_id: m.tool_call_id ?? '', content: m.content }]
        return { role: 'user', content }
      }
      return { role: 'user', content: m.content }
    }),
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
