import { log } from '../log.ts'
import type { RuntimeEventLog } from './event-log.ts'

export interface AuditInput {
  kind: string
  sessionId?: string
  agentId?: string
  taskId?: string
  requestId?: string
  level?: 'info' | 'warn' | 'error'
  payload?: Record<string, unknown>
}

function compact(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.length > 300 ? `${value.slice(0, 300)}...` : value
}

export function recordAudit(runtimeEvents: RuntimeEventLog | undefined, input: AuditInput): void {
  const payload = Object.fromEntries(Object.entries(input.payload ?? {}).map(([key, value]) => [key, compact(value)]))
  const record = {
    kind: input.kind,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...payload,
  }
  if (runtimeEvents && input.sessionId) {
    try {
      runtimeEvents.append({
        type: 'audit',
        sessionId: input.sessionId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.requestId ? { correlationId: input.requestId } : {}),
        payload: record,
      })
    } catch {
    }
  }
  log(input.level ?? 'info', `[audit] ${JSON.stringify(record)}`)
}
