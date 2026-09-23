import type { PermissionMode } from '../permission/types.ts'
import type { ChatMessage } from '../provider/types.ts'
import type { Tool } from '../tools/index.ts'
import type { RuntimeEvidenceSummary } from '../runtime/index.ts'

export type AgentRoleSource = 'builtin' | 'user' | 'project'

export interface AgentRole {
  name: string
  description: string
  toolsAllow?: string[]
  toolsDeny?: string[]
  writePaths?: string[] // rootLock 外额外允许写路径(如报告产出目录)
  model?: string
  maxRounds?: number
  permission?: PermissionMode
  isolation?: 'worktree'
  content: string
  source: AgentRoleSource
}

export interface SpawnRequest {
  type: 'defined' | 'fork'
  role?: string
  prompt: string
  async?: boolean
  taskId?: string
  parentAgentId?: string
  parentHistory?: ChatMessage[]
  parentTools?: Tool[]
}

export type SubAgentStatus = 'created' | 'running' | 'done' | 'error' | 'cancelled' | 'timed_out'

export interface SubAgentRecord {
  id: string
  role: string
  type: 'defined' | 'fork'
  status: SubAgentStatus
  sessionId?: string
  parentAgentId?: string
  taskId?: string
  startedAt: number
  updatedAt?: number
  finishedAt?: number
  ownerId?: string
  leaseExpiresAt?: number
  cancelRequestedAt?: number
  cancelReason?: string
  tokens?: number
  reportId?: string
  result?: string
  error?: string
  evidence?: RuntimeEvidenceSummary
}
