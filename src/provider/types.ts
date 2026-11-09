import type { JsonSchema } from '../tools/types.ts'

export interface ToolCallMeta {
  id: string
  name: string
  arguments: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCallMeta[]
  tool_call_id?: string
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ProviderTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface StreamChatOptions {
  thinking?: boolean
  tools?: ProviderTool[]
  signal?: AbortSignal
}

export interface Provider {
  readonly protocol: 'anthropic' | 'openai'
  streamChat(messages: ChatMessage[], opts: StreamChatOptions): AsyncGenerator<StreamEvent>
}
