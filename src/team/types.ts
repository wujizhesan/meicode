import type { RuntimeEvidenceSummary } from '../runtime/index.ts'

export interface TeamMember {
  name: string
  agentId?: string
  role: string
  workdir: string
  backend: 'coroutine'
  needsApproval: boolean
  status: 'idle' | 'busy' | 'offline'
  updatedAt?: number
}

export interface TeamTask {
  id: string
  title: string
  assignee?: string
  status: 'todo' | 'in_progress' | 'done' | 'failed' | 'cancelled'
  dispatchId?: string
  depends_on?: string[]
  createdAt?: number
  updatedAt?: number
  attempt?: number
  maxAttempts?: number
  activeAgentId?: string
  reportId?: string
  report?: TeamTaskReport
  leaseId?: string
  leaseExpiresAt?: number
  nextRetryAt?: number
  lastError?: string
  result?: string
}

export interface TeamTaskReport {
  reportId: string
  status: 'done' | 'failed' | 'cancelled'
  summary: string
  tokens?: number
  durationMs?: number
  error?: string
  evidence?: RuntimeEvidenceSummary
  artifacts?: string[]
  changedFiles?: string[]
  tests?: { command: string; passed: boolean; output?: string }[]
}

export interface MailMessage {
  messageId?: string
  groupId?: string
  kind?: string
  taskId?: string
  correlationId?: string
  from: string
  to: string // 成员名或 '*'
  body: string
  ts: number
  read: boolean
  summary?: string
}

export interface TeamGroup {
  name: string
  lead: string
  members: TeamMember[]
}
