import type { PermissionMode } from '../permission/types.ts'
import type { ChatMessage } from '../provider/types.ts'
import type { Tool } from '../tools/index.ts'

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
  parentHistory?: ChatMessage[]
  parentTools?: Tool[]
}

export type SubAgentStatus = 'running' | 'done' | 'error'

export interface SubAgentRecord {
  id: string
  role: string
  type: 'defined' | 'fork'
  status: SubAgentStatus
  startedAt: number
  finishedAt?: number
  tokens?: number
  result?: string
  error?: string
}
