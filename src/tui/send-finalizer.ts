import { buildPrompt } from '../agent/prompt/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import { persistSessionHistoryWithConflictCopy } from '../memory/index.ts'
import type { MemoryContext, SessionPersistenceCursor } from '../memory/index.ts'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { runIsolated } from '../skill/index.ts'
import type { SkillManager } from '../skill/index.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import type { UIMessage } from './types.ts'

export interface SendFinalizerOptions {
  provider: Provider
  history: History
  registry: ToolRegistry
  ctx: ToolContext
  memory?: MemoryContext
  skillManager?: SkillManager | null
  hooks?: Pick<HookEngine, 'fire'> | null
  startLength: number
  persistenceCursor: SessionPersistenceCursor
  appendMessage: (message: UIMessage) => void
  onSessionChange?: (sessionId: string) => void
  cwd?: string
}

export interface SendFinalizerDependencies {
  runIsolatedSkill?: typeof runIsolated
}

async function finalizeIsolatedSkill(
  options: SendFinalizerOptions,
  runIsolatedSkill: typeof runIsolated,
): Promise<void> {
  const { skillManager } = options
  if (!skillManager) return
  try {
    const activated = skillManager.lastActivated
    if (!activated || activated.mode !== 'isolated' || !skillManager.isActive(activated.name)) return
    const skill = skillManager.get(activated.name)
    if (!skill) return
    try {
      const skillTools = skill.tools ? new Set([...skill.tools, 'load_skill']) : null
      const summary = await runIsolatedSkill(skill, options.history, {
        provider: options.provider,
        registry: options.registry,
        ctx: options.ctx,
        systemPrompt: buildPrompt('full'),
        toolsOverride: skillTools
          ? options.registry.toOpenAITools().filter((tool) => skillTools.has(tool.function.name))
          : null,
      })
      options.history.push({ role: 'system', content: `[Skill ${skill.name} 结果] ${summary}` })
      options.appendMessage({ role: 'tool', text: `📦 [Skill ${skill.name} 结果] ${summary.slice(0, 300)}` })
    } catch (error) {
      const message = `[Skill ${skill.name} 结果] 执行失败：${(error as Error).message}`
      options.history.push({ role: 'system', content: message })
      options.appendMessage({ role: 'tool', text: `⚠ ${message}` })
    }
  } finally {
    skillManager.lastActivated = null
  }
}

async function fireMessageHook(options: SendFinalizerOptions): Promise<void> {
  const message = options.history.view()[options.startLength]
  if (!message) return
  try {
    await options.hooks?.fire('message', {
      cwd: options.cwd ?? process.cwd(),
      sessionId: options.ctx.sessionId,
      agentId: options.ctx.agentId,
      message,
    })
  } catch {
  }
}

function persistRemainingHistory(options: SendFinalizerOptions): void {
  const { memory } = options
  if (!memory?.sessionStore || !memory.sessionId) return
  try {
    const result = persistSessionHistoryWithConflictCopy(memory.sessionStore, memory.sessionId, options.history, options.persistenceCursor)
    if (result.conflictCopyId) {
      memory.sessionStore.recoverById(result.conflictCopyId)
      options.onSessionChange?.(result.conflictCopyId)
      memory.sessionId = result.conflictCopyId
      options.ctx.sessionId = result.conflictCopyId
      options.persistenceCursor.length = options.history.length
      options.persistenceCursor.structureVersion = options.history.structureVersion
      options.appendMessage({
        role: 'tool',
        text: `⚠️ 会话已被其他进程更新；当前本地内容已保存为冲突副本 ${result.conflictCopyId}，并已自动切换到该副本继续。`,
      })
    }
  } catch (error) {
    options.appendMessage({ role: 'tool', text: `⚠️ 会话保存失败：${(error as Error).message}` })
  }
}

export async function finalizeSend(
  options: SendFinalizerOptions,
  dependencies: SendFinalizerDependencies = {},
): Promise<void> {
  await finalizeIsolatedSkill(options, dependencies.runIsolatedSkill ?? runIsolated)
  await fireMessageHook(options)
  persistRemainingHistory(options)
}
