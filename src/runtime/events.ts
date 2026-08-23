import type { RuntimeIdPrefix } from './ids.ts'

export type RuntimeEventType =
  | 'run_started'
  | 'run_finished'
  | 'turn_started'
  | 'model_request'
  | 'context_snapshot'
  | 'tool_call'
  | 'tool_result'
  | 'turn_finished'
  | 'subagent_started'
  | 'subagent_finished'
  | 'task_created'
  | 'task_assigned'
  | 'task_finished'
  | 'message_sent'
  | 'report_ready'
  | 'report_acknowledged'
  | 'audit'

export interface RuntimeEventInput {
  type: RuntimeEventType
  sessionId: string
  agentId?: string
  taskId?: string
  turn?: number
  step?: number
  correlationId?: string
  causationId?: string
  payload?: Record<string, unknown>
}

export interface RuntimeEvent extends RuntimeEventInput {
  eventId: `${RuntimeIdPrefix}_${string}`
  seq: number
  ts: number
}
