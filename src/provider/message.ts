import type { ChatMessage, ToolCallMeta } from './types.ts'

const ROLES = new Set<ChatMessage['role']>(['system', 'user', 'assistant', 'tool'])

function isToolCall(value: unknown): value is ToolCallMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const call = value as Record<string, unknown>
  return typeof call.id === 'string'
    && call.id.length > 0
    && typeof call.name === 'string'
    && call.name.length > 0
    && typeof call.arguments === 'string'
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  if (typeof message.role !== 'string' || !ROLES.has(message.role as ChatMessage['role'])) return false
  if (typeof message.content !== 'string') return false
  if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || !message.tool_calls.every(isToolCall))) return false
  if (Array.isArray(message.tool_calls) && new Set(message.tool_calls.map((call) => call.id)).size !== message.tool_calls.length) return false
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') return false
  if (message.role === 'assistant') return message.tool_call_id === undefined
  if (message.role === 'tool') return typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0 && message.tool_calls === undefined
  return message.tool_calls === undefined && message.tool_call_id === undefined
}

export function assertChatMessages(messages: readonly unknown[]): asserts messages is readonly ChatMessage[] {
  const invalid = messages.findIndex((message) => !isChatMessage(message))
  if (invalid >= 0) throw new Error(`第 ${invalid + 1} 条消息结构非法`)
}
