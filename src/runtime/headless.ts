import { runAgent } from '../agent/loop.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import type { HookEngine } from '../hook/index.ts'
import { buildMemoryTail, createSessionPersistenceCursor, persistSessionHistoryWithConflictCopy } from '../memory/index.ts'
import type { MemoryContext } from '../memory/index.ts'
import type { RuleEngine } from '../permission/index.ts'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { TeamManager } from '../team/index.ts'
import type { ToolRegistry } from '../tools/index.ts'
import { createAgentRuntimeContext } from './agent-context.ts'

export interface HeadlessRunOptions {
  provider: Provider
  history: History
  registry: ToolRegistry
  engine: RuleEngine
  memory: MemoryContext
  teamManager: TeamManager
  hooks: HookEngine
  contextWindow: number
  yolo: boolean
}

export async function runHeadless(task: string, opts: HeadlessRunOptions): Promise<void> {
  const { provider, history, registry, engine, memory } = opts
  const persistenceCursor = createSessionPersistenceCursor(history)
  const ctx = createAgentRuntimeContext({
    provider,
    history,
    engine,
    cwd: process.cwd(),
    sessionId: memory.sessionId,
    runtimeEvents: memory.runtimeEvents,
    hooks: opts.hooks,
    contextWindow: opts.contextWindow,
    permissionMode: opts.yolo ? 'permissive' : 'unattended',
  })
  history.push({ role: 'user', content: task })
  const agent = runAgent({
    provider,
    history,
    registry,
    ctx,
    maxIterations: 50,
    mode: 'full',
    systemPrompt: buildPrompt('full') + buildMemoryTail(memory),
    unknownToolLimit: 2,
    teamBusy: () => opts.teamManager.listGroups().some((group) =>
      opts.teamManager.listTasks(group).some((item) => item.status === 'in_progress')),
  })
  for await (const event of agent.events) {
    if (event.type === 'text') process.stdout.write(event.text)
    else if (event.type === 'progress' && event.round > 1) process.stdout.write(`\n[round ${event.round}] `)
  }
  const result = await agent.done
  const deadline = Date.now() + 600000
  let waited = false
  while (Date.now() < deadline) {
    const busy = opts.teamManager.listGroups().some((group) =>
      opts.teamManager.listTasks(group).some((item) => item.status === 'in_progress'))
    if (!busy) break
    if (!waited) {
      console.log('[等待] 团队任务执行中...')
      waited = true
    }
    const event = await memory.runtimeEvents?.waitForEvent(
      memory.sessionId ?? ctx.agentId!,
      Math.min(60000, deadline - Date.now()),
    )
    const stillBusy = opts.teamManager.listGroups().some((group) =>
      opts.teamManager.listTasks(group).some((item) => item.status === 'in_progress'))
    if (!event && stillBusy) {
      console.log('[等待] 团队任务卡死（60s 无日志活动，退出）')
      break
    }
  }
  if (waited) console.log('[等待] 团队任务已结束')
  if (memory.sessionStore && memory.sessionId) {
    const persisted = persistSessionHistoryWithConflictCopy(memory.sessionStore, memory.sessionId, history, persistenceCursor)
    if (persisted.conflictCopyId) console.warn(`[记忆] 会话写入冲突，本次结果已保存为副本 ${persisted.conflictCopyId}`)
  }
  const error = result.errorMessage ? `\n[错误] ${result.errorMessage}` : ''
  console.log(`\n\n[完成] reason=${result.reason} rounds=${result.rounds} tokens=${result.totalTokens}${error}`)
}
