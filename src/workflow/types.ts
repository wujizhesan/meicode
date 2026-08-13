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

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused'

export interface PhaseRunRecord {
  title: string
  status: PhaseStatus
  agentId?: string
  artifactPath?: string // 产物：artifacts/<phase>.md
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'

export interface WorkflowRunRecord {
  runId: string
  workflow: string
  status: WorkflowRunStatus
  phases: PhaseRunRecord[]
  createdAt: number
  finishedAt?: number
}
