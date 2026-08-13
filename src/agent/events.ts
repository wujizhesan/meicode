import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { JsonSchema, ToolContext, ToolRegistry } from '../tools/index.ts'

export type StopReason = 'complete' | 'max_iterations' | 'cancelled' | 'unknown_tool' | 'tool_failures' | 'tool_repeat' | 'error'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; success: boolean; summary: string }
  | {
      type: 'usage'
      round: number
      inputTokens: number
      outputTokens: number
      cacheHitTokens?: number
      cacheMissTokens?: number
    }
  | { type: 'progress'; round: number; max: number; status: string }
  | { type: 'done'; reason: StopReason; rounds: number; totalTokens: number; errorMessage?: string }

export interface AgentOptions {
  provider: Provider
  history: History
  registry: ToolRegistry
  ctx: ToolContext
  maxIterations: number
  mode: 'plan' | 'full'
  systemPrompt: string
  unknownToolLimit: number
  toolsOverride?: { type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }[] | null
  extraSystemMessages?: string[] // P10：激活 Skill 指令（独立 system 消息，不进稳定前缀）
  injectSystem?: () => string[] // P12：请求前注入（子任务结果回流，取后清空，永不插 assistant/tool 中间）
  teamBusy?: () => boolean // 团队任务进行中判断器：纯文本轮且团队忙时不判 complete（防"[等待]"当最终输出中断编排）
}

export interface AgentResult {
  reason: StopReason
  rounds: number
  totalTokens: number
  finalText: string
  errorMessage?: string
}

export interface AgentHandle {
  events: AsyncIterable<AgentEvent>
  cancel(): void
  done: Promise<AgentResult>
}
