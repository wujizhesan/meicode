// Workflow 类型（对齐 Zcode 3.7.5：.workflow.js 的 export const meta = { name, description, phases }）

export interface WorkflowPhase {
  title: string // phase 标题（phaseOrder 唯一性依据）
  prompt: string // 该 phase 派发的 agent 任务描述
  agents?: number // 并行 agent 数（默认 1）
  whenToUse?: string // 适用场景说明（参考）
}

export interface WorkflowMeta {
  name: string
  description?: string
  phases: WorkflowPhase[]
}

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'

export interface PhaseDispatchSlot {
  slot: number
  dispatchId: string
  status: 'dispatching' | 'running' | 'settled'
  backend: 'subagent' | 'team'
  agentId?: string
  taskId?: string
  teamGroup?: string
}

export interface PhaseRunRecord {
  title: string
  status: PhaseStatus
  backend?: 'subagent' | 'team'
  agentId?: string
  agentIds?: string[]
  taskIds?: string[]
  dispatchSlots?: PhaseDispatchSlot[]
  teamGroup?: string
  artifactPath?: string // 产物：artifacts/<phase>.md
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'

export interface WorkflowRunRecord {
  runId: string
  workflow: string
  sessionId?: string
  backend?: 'subagent' | 'team'
  definitionHash?: string
  status: WorkflowRunStatus
  phases: PhaseRunRecord[]
  createdAt: number
  updatedAt?: number
  finishedAt?: number
  revision?: number
  leaseId?: string
  leaseExpiresAt?: number
  reconcileAttempts?: number
  lastReconcileError?: string
  nextReconcileAt?: number
  reconcileBlocked?: boolean
}
