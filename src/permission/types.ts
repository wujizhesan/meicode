export type PermissionMode = 'strict' | 'default' | 'unattended' | 'permissive'

export type RuleSource = 'user' | 'project' | 'local' | 'session'

export interface Rule {
  tool: string
  pattern: string
  action: 'allow' | 'deny'
  source: RuleSource
}

export type Decision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'ask'; reason?: string } // reason: 危险命令警告等弹窗文案

export type AskResult = 'once' | 'session' | 'forever' | 'deny'

export interface ToolCallInfo {
  name: string
  args: Record<string, unknown>
  reason?: string // ask 弹窗文案（危险命令警告等）
}

// 引擎最小接口（避免 types ↔ rules 循环依赖）
export interface PermissionEngineLike {
  match(call: ToolCallInfo, sessionId?: string): Rule | null
  addSessionRule(rule: Omit<Rule, 'source'>, sessionId?: string): void
  clearSessionRules?(sessionId?: string): void
  appendProjectRule(rule: Omit<Rule, 'source'>): void
}

export interface PermissionContext {
  mode: PermissionMode
  engine: PermissionEngineLike
  autoAcceptEdits?: boolean // Accept Edits：文件编辑工具（write/edit）豁免弹窗
}
