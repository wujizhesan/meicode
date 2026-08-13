export interface TeamMember {
  name: string
  role: string
  workdir: string
  backend: 'coroutine'
  needsApproval: boolean
  status: 'idle' | 'busy' | 'offline'
}

export interface TeamTask {
  id: string
  title: string
  assignee?: string
  status: 'todo' | 'in_progress' | 'done' | 'failed'
  depends_on?: string[]
  result?: string
}

export interface MailMessage {
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
