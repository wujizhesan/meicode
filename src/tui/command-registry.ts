import { BUILTIN_COMMANDS, CommandRegistry } from '../commands/index.ts'
import type { SkillManager } from '../skill/index.ts'

export function createAppCommandRegistry(skillManager?: SkillManager | null): CommandRegistry {
  const registry = new CommandRegistry()
  for (const command of BUILTIN_COMMANDS) registry.register(command)
  for (const skill of skillManager?.list() ?? []) {
    try {
      registry.register({
        name: skill.name,
        description: skill.description,
        usage: `/${skill.name}`,
        type: 'prompt',
        handler: (args, ui) => {
          ui.skillActivate(skill.name)
          ui.sendUserMessage(args.length > 0 ? `执行 Skill ${skill.name}：${args.join(' ')}` : `执行 Skill ${skill.name}`)
        },
      })
    } catch {
    }
  }
  return registry
}
