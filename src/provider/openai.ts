import { createParser } from 'eventsource-parser'
import { withIdleTimeout, withRequestTimeout } from './timeout.ts'
import type { ProviderConfig } from '../config/types.ts'
import type { JsonSchema } from '../tools/types.ts'
import type { ChatMessage, Provider, StreamEvent } from './types.ts'
import { log } from '../log.ts'

interface ToolCallAcc {
  id?: string
  name?: string
  args: string
}

export class OpenAIProvider implements Provider {
  readonly protocol = 'openai' as const
  private cfg: ProviderConfig

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
  }

  async *streamChat(
    messages: ChatMessage[],
    opts: { thinking?: boolean; tools?: { type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }[]; signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    const base = this.cfg.base_url.replace(/\/+$/, '')
    const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/v1/chat/completions`
    // 外部取消（用户 Ctrl+C）→ abort 请求；超时也 abort（见 withRequestTimeout）
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

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
            max_tokens: 16384,
            stream_options: { include_usage: true },
            ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
          }),
          signal: controller.signal,
        }),
        60000,
        controller,
      )
    } catch (e) {
      opts.signal?.removeEventListener('abort', onAbort)
      log('error', `openai 请求失败: ${(e as Error).message}`)
      yield { type: 'error', message: `网络请求失败: ${(e as Error).message}` }
      return
    }
    opts.signal?.removeEventListener('abort', onAbort)

    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`
      try {
        const body = await res.text()
        if (body) detail = `${detail}: ${body.slice(0, 500)}`
      } catch {
        // 忽略响应体读取失败
      }
      log('error', `openai API 错误: ${detail.slice(0, 300)}`)
      yield { type: 'error', message: `OpenAI API 错误: ${detail}` }
      return
    }

    let queue: StreamEvent[] = []
    let wake: ((ev: StreamEvent) => void) | null = null
    let doneSent = false
    const toolAcc = new Map<number, ToolCallAcc>()

    const push = (ev: StreamEvent) => {
      if (wake) {
        wake(ev)
        wake = null
      } else {
        queue.push(ev)
      }
    }

    // [DONE] 或流结束时：聚合的 tool_calls 先于 done 事件发出
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
            const acc = toolAcc.get(part.index) ?? { args: '' }
            if (part.id) acc.id = part.id
            if (part.function?.name) acc.name = part.function.name
            if (part.function?.arguments) acc.args += part.function.arguments
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
        // 每收到一个 chunk 立即把新事件交给消费方，保证真流式
        while (queue.length > 0) yield queue.shift()!
      }
    } catch (e) {
      log('error', `openai 流读取失败: ${(e as Error).message}`)
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
    return { role: m.role, content: m.content }
  })
}
