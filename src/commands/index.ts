import type { CommandRegistry } from './registry.ts'
import type { UiController } from './types.ts'
import { parseCommandLine } from './parser.ts'

export function createDispatcher(registry: CommandRegistry, ui: UiController): {
  dispatch(input: string): boolean
  complete(prefix: string): string[]
} {
  return {
    // true = 命令已处理（斜杠）；false = 走对话
    dispatch(input: string): boolean {
      const parsed = parseCommandLine(input)
      if (!parsed) return false
      const cmd = registry.find(parsed.name)
      if (!cmd) {
        ui.showMessage(`未知命令 /${parsed.name}，输入 /help 查看命令列表`)
        return true
      }
      void cmd.handler(parsed.args, ui)
      return true
    },
    complete(prefix: string): string[] {
      return registry.complete(prefix)
    },
  }
}

export { CommandRegistry } from './registry.ts'
export { parseCommandLine } from './parser.ts'
export { BUILTIN_COMMANDS } from './builtin.ts'
export type { CommandDef, UiController, CommandType, ParsedCommand } from './types.ts'
