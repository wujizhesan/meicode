export type CommandType = 'local' | 'ui' | 'prompt'

export interface CommandDef {
  name: string
  aliases?: string[]
  description: string
  usage: string
  type: CommandType
  paramHint?: string
  hidden?: boolean
  handler: (args: string[], ui: UiController) => void | Promise<void>
}

// 界面控制接口：命令实现只依赖此接口，不绑定渲染框架
export interface UiController {
  showMessage(text: string): void
  sendUserMessage(text: string): void
  setMode(mode: string): void
  clearHistory(): void
  compact(): Promise<string>
  sessionAction(action: 'list' | 'resume' | 'new' | 'del', arg?: string): string
  snapshotAction(action: 'snapshot' | 'rollback', arg?: string): string | Promise<string>
  memoryList(): string
  permissionSummary(): string
  getStatus(): string
  listCommands(includeHidden?: boolean): CommandDef[]
  skillList(): string
  skillActivate(name: string): string
  skillDeactivate(name: string): string
  teamAction(action: string, args: string[]): string
  workflowAction(action: string, args: string[]): string
  auditAction(args: string[]): string
}

export interface ParsedCommand {
  name: string
  args: string[]
}
