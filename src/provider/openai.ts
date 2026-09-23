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
import type { ChatMessage, Provider, StreamChatOptions, StreamEvent } from './types.ts'
import { log } from '../log.ts'

export class OpenAIProvider implements Provider {
  readonly protocol = 'openai' as const
  private readonly cfg: ProviderConfig

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
  }

  async *streamChat(messages: ChatMessage[], opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    const base = this.cfg.base_url.replace(/\/+$/, '')
    const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/v1/chat/completions`
    const request = linkAbortSignal(opts.signal)

    let res: Response
    try {
      res = await withRequestTimeout(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.cfg.api_key}`,
          },
          body: JSON.stringify({
            model: this.cfg.model,
            messages: toOpenAIMessages(messages),
            stream: true,
            // 输出上限：DeepSeek 默认 4K，长回答/写大文件会截断——显式 16K
            max_tokens: this.cfg.max_output_tokens ?? 16384,
            stream_options: { include_usage: true },
            ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
          }),
          signal: request.controller.signal,
        }),
        60000,
        request.controller,
      )
    } catch (e) {
      request.dispose()
      log('error', `openai 请求失败: ${(e as Error).message}`)
      yield { type: 'error', message: `网络请求失败: ${(e as Error).message}` }
      return
    }
    request.dispose()

    if (!res.ok || !res.body) {
      const detail = await getResponseErrorDetail(res)
      log('error', `openai API 错误: ${detail.slice(0, 300)}`)
      yield { type: 'error', message: `OpenAI API 错误: ${detail}` }
      return
    }

    const queue: StreamEvent[] = []
    let doneSent = false
    const toolAcc = new Map<number, ToolCallAccumulator>()

    const push = (event: StreamEvent) => queue.push(event)

    // [DONE] 或流结束时：聚合的 tool_calls 先于 done 事件发出
    const flushTools = () => {
      queue.push(...drainToolCalls(toolAcc))
    }

    const parser = createParser({
      onEvent: (event) => {
        if (!event.data) return
        if (event.data === '[DONE]') {
          flushTools()
          doneSent = true
          push({ type: 'done' })
          return
        }
        let data: {
          choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_cache_hit_tokens?: number
            prompt_cache_miss_tokens?: number
          }
          error?: { message?: string }
        }
        try {
          data = JSON.parse(event.data)
        } catch {
          return
        }
        // include_usage 的最终 chunk：choices 为空数组，带 usage（含 DeepSeek 缓存字段）
        if (data.usage && data.usage.prompt_tokens !== undefined) {
          push({
            type: 'usage',
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens ?? 0,
            cacheHitTokens: data.usage.prompt_cache_hit_tokens,
            cacheMissTokens: data.usage.prompt_cache_miss_tokens,
          })
        }
        const delta = data.choices?.[0]?.delta
        const toolCalls = delta?.tool_calls
        if (toolCalls) {
          for (const part of toolCalls) {
            const acc = toolAcc.get(part.index) ?? { args: [] }
            if (part.id) acc.id = part.id
            if (part.function?.name) acc.name = part.function.name
            if (part.function?.arguments) acc.args.push(part.function.arguments)
            toolAcc.set(part.index, acc)
          }
          return
        }
        if (delta?.content) push({ type: 'text', text: delta.content })
        else if (data.error?.message) {
          flushTools()
          doneSent = true
          push({ type: 'error', message: data.error.message })
        }
      },
    })

    try {
      const decoder = new TextDecoder()
      for await (const value of readResponseStream(res.body, opts.signal)) {
        parser.feed(decoder.decode(value, { stream: true }))
        // 每收到一个 chunk 立即把新事件交给消费方，保证真流式
        for (const event of queue) yield event
        queue.length = 0
      }
    } catch (e) {
      log('error', `openai 流读取失败: ${(e as Error).message}`)
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

// ChatMessage 历史 → OpenAI messages 格式
// - assistant 带 tool_calls：content 必须为 null（OpenAI 规范）
// - tool 消息：tool_call_id + content
export function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id ?? '', content: m.content }
    }
    if (m.tool_calls === undefined && m.tool_call_id === undefined) return m as unknown as Record<string, unknown>
    return { role: m.role, content: m.content }
  })
}
