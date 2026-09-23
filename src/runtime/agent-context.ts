import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { RuleEngine } from '../permission/index.ts'
import type { PermissionMode } from '../permission/types.ts'
import type { HookEngine } from '../hook/engine.ts'
import type { ToolContext } from '../tools/index.ts'
import { ContextManager, spillBatch } from '../context/index.ts'
import type { RuntimeEventLog } from './event-log.ts'
import { createRuntimeId } from './ids.ts'

export interface AgentRuntimeContextOptions {
  provider: Provider
  history: History
  engine: RuleEngine
  cwd: string
  contextWindow?: number
  permissionMode?: PermissionMode
  autoAcceptEdits?: boolean
  sessionId?: string
  agentId?: string
  taskId?: string
  runtimeEvents?: RuntimeEventLog
  hooks?: HookEngine
  rootLock?: string
  rootLockExtra?: string[]
  timeoutMs?: number
}

export function createAgentRuntimeContext(options: AgentRuntimeContextOptions): ToolContext {
  const agentId = options.agentId ?? createRuntimeId('agent')
  const contextManager = new ContextManager({
    provider: options.provider,
    history: options.history,
    cwd: options.cwd,
    window: options.contextWindow ?? 131072,
    hooks: options.hooks,
    sessionId: options.sessionId,
    agentId,
  })
  const context: ToolContext = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    agentId,
    taskId: options.taskId,
    runtimeEvents: options.runtimeEvents,
    rootLock: options.rootLock ?? options.cwd,
    rootLockExtra: options.rootLockExtra,
    timeoutMs: options.timeoutMs ?? 30000,
    permission: {
      mode: options.permissionMode ?? 'unattended',
      engine: options.engine,
      autoAcceptEdits: options.autoAcceptEdits ?? true,
    },
    hooks: options.hooks,
  }
  context.spill = (results) => spillBatch(results, options.cwd)
  context.contextBudget = () => contextManager.snapshot()
  context.beforeRequest = (mode) => contextManager.beforeRequest(mode)
  context.afterRequest = (usage, count) => contextManager.afterRequest(usage, count)
  return context
}
