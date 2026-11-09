import { buildPrompt } from '../agent/prompt/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import { persistSessionHistoryWithConflictCopy } from '../memory/index.ts'
import type { MemoryContext, SessionPersistenceCursor, SubAgentTaskSource } from '../memory/index.ts'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { runIsolated, SkillRunError } from '../skill/index.ts'
import type { SkillManager } from '../skill/index.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import type { UIMessage } from './types.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import type { StopReason } from '../agent/events.ts'

export interface SendFinalizerOptions {
  provider: Provider
  history: History
  registry: ToolRegistry
  ctx: ToolContext
  signal?: AbortSignal
  mode?: 'plan' | 'full'
  reason: StopReason
  memory?: MemoryContext
  skillManager?: SkillManager | null
  hooks?: Pick<HookEngine, 'fire'> | null
  startLength: number
  persistenceCursor: SessionPersistenceCursor
  appendMessage: (message: UIMessage) => void
  onSessionChange?: (sessionId: string) => void
  getConflictTaskSources?: () => readonly SubAgentTaskSource[]
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
  if (options.reason !== 'complete' || options.signal?.aborted) {
    skillManager.clearPendingIsolated()
    return
  }
  if (options.mode === 'plan') return
  try {
    const executed = new Set<string>()
    while (!options.signal?.aborted) {
      const skill = skillManager.takeNextIsolated()
      if (!skill) break
      if (executed.has(skill.name)) continue
      executed.add(skill.name)
      try {
        const skillTools = skill.tools ? new Set([...skill.tools, 'load_skill']) : null
        const summary = await runIsolatedSkill(skill, options.history, {
          provider: options.provider,
          registry: options.registry,
          skillManager,
          ctx: options.ctx,
          signal: options.signal,
          systemPrompt: buildPrompt('full'),
          toolsOverride: skillTools
            ? options.registry.toOpenAITools().filter((tool) => skillTools.has(tool.function.name))
            : null,
        })
        if (options.signal?.aborted) return
        options.history.push({ role: 'system', content: `[Skill ${skill.name} 结果] ${summary}` })
        options.appendMessage({ role: 'tool', text: `📦 [Skill ${skill.name} 结果] ${summary.slice(0, 300)}` })
      } catch (error) {
        if (options.signal?.aborted) return
        const summaryFailed = error instanceof SkillRunError && error.stage === 'summary'
        const failure = summaryFailed ? '执行已完成，但摘要失败' : '执行失败'
        const detail = error instanceof Error ? error.message : String(error)
        const output = error instanceof SkillRunError && error.output
          ? `\n${summaryFailed ? '执行输出' : '部分输出'}：${error.output}`
          : ''
        const message = `[Skill ${skill.name} 结果] ${failure}：${detail}${output}`
        options.history.push({ role: 'system', content: message })
        options.appendMessage({ role: 'tool', text: `⚠ ${message.slice(0, 300)}` })
      }
    }
  } finally {
    if (options.signal?.aborted) skillManager.clearPendingIsolated()
    skillManager.lastActivated = null
  }
}

async function fireMessageHook(options: SendFinalizerOptions): Promise<void> {
  if (options.signal?.aborted || !options.hooks) return
  const message = options.history.view()[options.startLength]
  if (!message) return
  try {
    await resolveOnAbort(() => options.hooks!.fire('message', {
      cwd: options.cwd ?? process.cwd(),
      sessionId: options.ctx.sessionId,
      agentId: options.ctx.agentId,
      message,
    }, options.signal), options.signal, undefined)
  } catch {
  }
}

export function persistRemainingHistory(options: Pick<SendFinalizerOptions,
  'memory' | 'history' | 'ctx' | 'persistenceCursor' | 'onSessionChange' | 'appendMessage' | 'getConflictTaskSources'>): boolean {
  const { memory } = options
  if (!memory?.sessionStore || !memory.sessionId) return true
  try {
    const result = persistSessionHistoryWithConflictCopy(memory.sessionStore, memory.sessionId, options.history, options.persistenceCursor, options.getConflictTaskSources)
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
    return true
  } catch (error) {
    options.appendMessage({ role: 'tool', text: `⚠️ 会话保存失败：${(error as Error).message}` })
    return false
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
