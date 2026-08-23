import { createParser } from 'eventsource-parser'
import { withIdleTimeout, withRequestTimeout } from './timeout.ts'
import type { ProviderConfig } from '../config/types.ts'
import type { JsonSchema } from '../tools/types.ts'
import type { ChatMessage, Provider, StreamEvent, ToolCallMeta } from './types.ts'
import { log } from '../log.ts'

const API_VERSION = '2023-06-01'

interface ToolUseAcc {
  id?: string
  name?: string
  args: string
}

// 同一轮多个工具结果的合并块（Anthropic 要求 tool_use 的所有 result 在同一条消息）
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export class AnthropicProvider implements Provider {
  readonly protocol = 'anthropic' as const
  private cfg: ProviderConfig

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
  }

  async *streamChat(
    messages: ChatMessage[],
    opts: { thinking?: boolean; tools?: { type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }[]; signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    const thinking = opts.thinking ?? this.cfg.thinking ?? false
    const base = this.cfg.base_url.replace(/\/+$/, '')
    // 外部取消（用户 Ctrl+C）→ abort 请求；超时也 abort（见 withRequestTimeout）
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    const body = toAnthropicBody(messages, this.cfg.model, thinking, opts.tools)

    let res: Response
    try {
      res = await withRequestTimeout(
        fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.cfg.api_key,
            authorization: `Bearer ${this.cfg.api_key}`, // DeepSeek 兼容层认 Bearer
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        60000,
        controller,
      )
    } catch (e) {
      opts.signal?.removeEventListener('abort', onAbort)
      log('error', `anthropic 请求失败: ${(e as Error).message}`)
      yield { type: 'error', message: `网络请求失败: ${(e as Error).message}` }
      return
    }
    opts.signal?.removeEventListener('abort', onAbort)

    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`
      try {
        const bodyText = await res.text()
        if (bodyText) detail = `${detail}: ${bodyText.slice(0, 500)}`
      } catch {
        // 忽略响应体读取失败
      }
      log('error', `anthropic API 错误: ${detail.slice(0, 300)}`)
      yield { type: 'error', message: `Anthropic API 错误: ${detail}` }
      return
    }

    let queue: StreamEvent[] = []
    let wake: ((ev: StreamEvent) => void) | null = null
    let doneSent = false
    const toolAcc = new Map<number, ToolUseAcc>()

    const push = (ev: StreamEvent) => {
      if (wake) {
        wake(ev)
        wake = null
      } else {
        queue.push(ev)
      }
    }

    // message_stop 前：把累积的 tool_use 块按序发出
    const flushTools = () => {
      for (const acc of toolAcc.values()) {
        if (!acc.id || !acc.name) {
          push({ type: 'error', message: '工具调用不完整（缺少 id 或 name）' })
          continue
        }
        try {
          const parsed = JSON.parse(acc.args || '{}')
          push({ type: 'tool_call', id: acc.id, name: acc.name, arguments: parsed })
        } catch {
          push({ type: 'error', message: `工具参数解析失败 (${acc.name}): ${acc.args.slice(0, 100)}` })
        }
      }
      toolAcc.clear()
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
          toolAcc.set(data.index ?? 0, { id: data.content_block.id, name: data.content_block.name, args: '' })
        } else if (data.type === 'content_block_delta') {
          const delta = data.delta
          if (delta?.type === 'text_delta') push({ type: 'text', text: delta.text ?? '' })
          else if (delta?.type === 'thinking_delta') push({ type: 'thinking', text: delta.thinking ?? '' })
          else if (delta?.type === 'input_json_delta') {
            const acc = toolAcc.get(data.index ?? 0) ?? { args: '' }
            acc.args += delta.partial_json ?? ''
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

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    // 流式阶段外部取消：cancel reader 立即中断（不用等 idle 超时）
    const onStreamAbort = () => {
      reader?.cancel().catch(() => {})
    }
    opts.signal?.addEventListener('abort', onStreamAbort, { once: true })
    try {
      reader = res.body.getReader()
      if (opts.signal?.aborted) await reader.cancel()
      const decoder = new TextDecoder()
      const IDLE_TIMEOUT = 30000 // 30s 无数据视为挂起，报错结束
      while (true) {
        const { done, value } = await withIdleTimeout(reader.read(), IDLE_TIMEOUT)
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
        while (queue.length > 0) yield queue.shift()!
      }
    } catch (e) {
      log('error', `anthropic 流读取失败: ${(e as Error).message}`)
      yield { type: 'error', message: `流读取失败: ${(e as Error).message}` }
      return
    } finally {
      opts.signal?.removeEventListener('abort', onStreamAbort)
      // 消费方 break/abort 时关闭底层流，释放 HTTP 连接
      if (reader) reader.cancel().catch(() => {})
    }

    if (!doneSent) {
      flushTools()
      push({ type: 'done' })
    }
    while (queue.length > 0) yield queue.shift()!
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
  tools?: { type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }[],
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
