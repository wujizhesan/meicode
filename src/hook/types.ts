import type { ChatMessage } from '../provider/types.ts'

export const HOOK_EVENTS = [
  'session_start',
  'session_end',
  'round_start',
  'round_end',
  'message',
  'tool_before',
  'tool_after',
  'permission_request',
  'permission_denied',
  'subagent_start',
  'subagent_stop',
  'pre_compact',
  'post_compact',
  'task_created',
  'task_completed',
  'teammate_idle',
  'app_start',
  'app_exit',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

export const INTERCEPT_EVENTS = new Set<HookEventName>(['tool_before'])

export interface HookClause {
  match: string // 字段路径：'name' | 'args.command' | 'content'
  pattern: string // 精确 / !反向 / /re/正则 / *glob
}

export interface HookCondition {
  all?: HookClause[]
  any?: HookClause[]
}

export type HookAction =
  | { type: 'command'; command: string; timeout?: number }
  | { type: 'inject_prompt'; content: string }
  | { type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { type: 'subagent'; name: string }

export interface HookRule {
  event: HookEventName
  if?: HookCondition
  action: HookAction
  once?: boolean
  async?: boolean
  fired?: boolean // once 运行时标记
}

export interface HookContext {
  cwd: string
  sessionId?: string
  targetAgentId?: string
  call?: { name: string; args: Record<string, unknown> }
  message?: ChatMessage
  round?: number
  // permission_request/denied：权限决策详情
  reason?: string
  decision?: string
  // subagent_start/stop：子任务身份
  agentId?: string
  role?: string
  // pre/post_compact：压缩统计
  stats?: string
}
