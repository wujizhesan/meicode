import { useEffect, useMemo, useRef, useState } from 'react'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { createMcpToolRegistrar } from '../mcp/index.ts'
import type { McpClientManager } from '../mcp/index.ts'
import { ContextManager, spillBatch } from '../context/index.ts'
import { buildMemoryTail, createSessionPersistenceCursor, tryPersistSessionHistory, updateNotes } from '../memory/index.ts'
import type { MemoryContext } from '../memory/index.ts'
import type { SkillManager } from '../skill/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import type { SubAgentManager } from '../subagent/index.ts'
import type { TeamManager } from '../team/index.ts'
import { resolveMode } from './mode.ts'
import { createRuntimeId } from '../runtime/index.ts'
import { createStreamBuffer, streamFlushDelay } from './stream-buffer.ts'
import { appendStreamChunk, stopReasonError } from './stream-presentation.ts'
import { createAgentEventHandler } from './agent-event-handler.ts'
import { runStreamingLifecycle, streamingFailureMessage } from './send-lifecycle.ts'
import { finalizeSend } from './send-finalizer.ts'
import type { AgentMode, Mode, UIMessage, UserMode } from './types.ts'
import { createSessionActions } from './session-actions.ts'
export type { AgentMode, Mode, UIMessage, UserMode } from './types.ts'

import type { StopReason } from '../agent/events.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import type { AskResult, PermissionMode, ToolCallInfo } from '../permission/types.ts'
import type { RuleEngine } from '../permission/index.ts'
import { reconcileReadyWorkflowRuns } from '../workflow/index.ts'

function snapshotToolContext(ctx: ToolContext): ToolContext {
  return {
    ...ctx,
    permission: ctx.permission ? { ...ctx.permission } : undefined,
  }
}

export function useStreamingChat(
  provider: Provider,
  history: History,
  registry: ToolRegistry,
  engine: RuleEngine,
  ask: (call: ToolCallInfo, signal?: AbortSignal) => Promise<AskResult>,
  elicit?: (question: string, options?: string[], signal?: AbortSignal) => Promise<string | null>,
  mcpManager?: McpClientManager | null,
  contextWindow = 131072,
  memory?: MemoryContext,
  skillManager?: SkillManager | null,
  hooks?: HookEngine | null,
  subAgentManager?: SubAgentManager | null,
  teamManager?: TeamManager | null,
  onSessionChange?: (sessionId: string) => void,
) {
  // P12：子任务结果回流主对话——不直接插 history（子任务完成时机不可控，
  // 可能落在 assistant(tool_calls) 与 tool 结果之间导致 400）；
  // 改为缓存队列，由 loop 每轮请求前注入为末尾 system（见 loop.ts injectSystem）
  const pendingSubResults = useRef<string[]>([])
  const workflowSettledNotices = useRef(new Set<string>())
  const agentIdRef = useRef(createRuntimeId('agent'))
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [mode, setMode] = useState<Mode>('idle')
  const [error, setError] = useState<string | null>(null)
  const [agentMode, setAgentMode] = useState<AgentMode>('full')
  const [permModeState, setPermModeState] = useState<PermissionMode>('default')
  const [roundInfo, setRoundInfo] = useState<{ round: number; max: number; status: string } | null>(null)
  const [totalTokens, setTotalTokens] = useState(0)
  const [cacheHit, setCacheHit] = useState(0)
  const [cacheMiss, setCacheMiss] = useState(0)
  const [lastReason, setLastReason] = useState<StopReason | null>(null)
  const streamingRef = useRef(false)
  const cancelRef = useRef<(() => void) | null>(null)
  const planTextRef = useRef('')
  const autoEditsRef = useRef(false)

  const ctx: ToolContext = {
    cwd: process.cwd(),
    sessionId: memory?.sessionId,
    agentId: agentIdRef.current,
    runtimeEvents: memory?.runtimeEvents,
    timeoutMs: 30000,
    permission: { mode: permModeState, engine, autoAcceptEdits: autoEditsRef.current },
    ask,
    elicit,
    hooks: hooks ?? undefined,
  }
  const toolContextRef = useRef<ToolContext>(ctx)
  toolContextRef.current = ctx
  // P7：上下文管理挂钩
  useEffect(() => {
    if (!subAgentManager) return
    let disposed = false
    let reconcileInFlight: Promise<void> | null = null
    let lastCoordinatorError = ''
    const reconcile = (): Promise<void> => {
      if (reconcileInFlight) return reconcileInFlight
      reconcileInFlight = reconcileReadyWorkflowRuns({
        cwd: process.cwd(),
        provider,
        registry,
        ctx: snapshotToolContext(toolContextRef.current),
        subagents: subAgentManager,
        team: teamManager,
        onError: (record, failure) => {
          if (disposed) return
          const retry = record.reconcileBlocked
            ? '自动恢复已暂停，请修复后使用 /workflow resume 手动重试'
            : `将在 ${new Date(record.nextReconcileAt ?? Date.now()).toLocaleTimeString()} 后重试`
          setMessages((prev) => [...prev, {
            role: 'tool',
            text: `⚠️ Workflow ${record.runId} 恢复失败（第 ${record.reconcileAttempts ?? 1} 次）：${failure.message}；${retry}`,
          }])
        },
        onSettled: (record) => {
          if (disposed || (record.status !== 'failed' && record.status !== 'cancelled')) return
          const key = `${record.runId}:${record.status}:${record.finishedAt ?? record.updatedAt ?? ''}`
          if (workflowSettledNotices.current.has(key)) return
          workflowSettledNotices.current.add(key)
          const detail = [...record.phases].reverse().find((phase) => phase.error)?.error
            ?? record.lastReconcileError
            ?? '未提供错误详情'
          setMessages((prev) => [...prev, {
            role: 'tool',
            text: `⚠️ Workflow ${record.runId} 已${record.status === 'failed' ? '失败' : '取消'}：${detail}`,
          }])
        },
        onCoordinatorError: (failure) => {
          if (disposed || failure.message === lastCoordinatorError) return
          lastCoordinatorError = failure.message
          setMessages((prev) => [...prev, { role: 'tool', text: `⚠️ Workflow 协调器异常：${failure.message}` }])
        },
      }).then(() => undefined, (failure: Error) => {
        if (disposed || failure.message === lastCoordinatorError) return
        lastCoordinatorError = failure.message
        setMessages((prev) => [...prev, { role: 'tool', text: `⚠️ Workflow 协调器异常：${failure.message}` }])
      }).finally(() => {
        reconcileInFlight = null
      })
      return reconcileInFlight
    }
    subAgentManager.setOnResult((record) => {
      if (record.sessionId && record.sessionId !== memory?.sessionId) return
      if (record.result) {
        const text = `📦 [子任务 ${record.role}] ${record.result}`
        pendingSubResults.current.push(`[子任务 ${record.role} 结果] ${record.result}`)
        setMessages((prev) => [...prev, { role: 'tool', text: text.slice(0, 300) }])
      }
      void reconcile()
    })
    const timer = setInterval(() => void reconcile(), 5000)
    timer.unref()
    void reconcile()
    return () => {
      disposed = true
      clearInterval(timer)
      subAgentManager.setOnResult(null)
    }
  }, [memory?.runtimeEvents, memory?.sessionId, provider, registry, subAgentManager, teamManager])

  const contextManager = useMemo(
    () => new ContextManager({ provider, history, cwd: process.cwd(), window: contextWindow, hooks: hooks ?? undefined, sessionId: memory?.sessionId, agentId: agentIdRef.current }),
    [provider, history, contextWindow, hooks],
  )
  ctx.spill = (results) => spillBatch(results, process.cwd())
  ctx.contextBudget = () => contextManager.snapshot()
  ctx.beforeRequest = (mode) => contextManager.beforeRequest(mode)
  ctx.afterRequest = (usage, count) => contextManager.afterRequest(usage, count)

  const resetSessionRuntime = (): void => {
    pendingSubResults.current = []
    workflowSettledNotices.current.clear()
  }
  const switchSessionRuntime = (sessionId: string): void => {
    onSessionChange?.(sessionId)
    ctx.sessionId = sessionId
    toolContextRef.current.sessionId = sessionId
    contextManager.setSessionId(sessionId)
  }

  const sessionActions = createSessionActions({
    history,
    memory,
    contextManager,
    skillManager,
    isStreaming: () => streamingRef.current,
    onSessionChange: switchSessionRuntime,
    resetRuntime: resetSessionRuntime,
    resetUi: () => {
      setMessages([])
      setLastReason(null)
      setError(null)
    },
  })

  const mcpRegistrar = useMemo(
    () => mcpManager ? createMcpToolRegistrar(registry, mcpManager) : null,
    [registry, mcpManager],
  )

  const send = async (text: string, opts?: { planContext?: string; pushUser?: boolean; modeOverride?: AgentMode }) => {
    const execute = async (): Promise<void> => {
      let mcpError: string | null = null
      // 首次发送前懒发现 MCP 远端工具（失败 Server 提示但不阻塞）
      if (mcpRegistrar && !mcpRegistrar.ready) {
        try {
          const result = await mcpRegistrar.discover()
          if (result.failed.length > 0) {
            mcpError = `MCP Server 连接失败: ${result.failed.map((f) => `${f.name}（${f.error.slice(0, 60)}）`).join('; ')}`
          }
          if (result.toolCount > 0) {
            console.log(`[MCP] 已接入 ${result.toolCount} 个远端工具（${result.registered.join(', ')}）`)
          }
        } catch (e) {
          mcpError = `MCP 发现失败: ${(e as Error).message}`
        }
      }
      setError(mcpError)
      const persistenceCursor = createSessionPersistenceCursor(history)
      let sessionConflict = false
      if (opts?.pushUser !== false) {
        setMessages((prev) => [...prev, { role: 'user', text }])
        history.push({ role: 'user', content: text })
      }

      const runMode = opts?.modeOverride ?? agentMode
      // 计划文本自动注入：从 plan 切回执行模式后的首次发送，注入后清空
      const planCtx = opts?.planContext ?? (runMode === 'full' && planTextRef.current ? planTextRef.current : undefined)
      if (planCtx && planCtx !== opts?.planContext) planTextRef.current = ''
      // P8：记忆注入（指令 + 索引拼主 system 尾部；索引每次 send 前重读）
      const memoryTail = buildMemoryTail(memory)
      const startLen = history.length
      // P10：Skill 激活注入（独立 system 消息，不进稳定前缀）+ 白名单收窄
      // P12：可用子 Agent 角色注入（模型直接知道有哪些角色，避免调查）
      const roleIndex = subAgentManager?.listRoles()
        .map((r) => `- ${r.name}${r.isolation === 'worktree' ? '（隔离 worktree）' : ''}: ${r.description}`)
        .join('\n') ?? ''
      const skillIndex = skillManager?.index() ?? ''
      const activePrompt = skillManager?.activePrompt() ?? ''
      const activeTools = skillManager?.activeToolNames()
      let toolsOverride: ReturnType<ToolRegistry['toOpenAITools']> | null = null
      if (activeTools) {
        const names = new Set([...activeTools, 'load_skill'])
        toolsOverride = registry.toOpenAITools().filter((t) => names.has(t.function.name))
      } else if (teamManager?.isCoordinator()) {
        // P14：coordinator 模式——Lead 剥夺写文件工具（保留读 + run_command + spawn）
        toolsOverride = teamManager.createLeadTools()
      }
      const agent = runAgent({
        provider,
        history,
        registry,
        ctx,
        maxIterations: 15,
        mode: runMode,
        systemPrompt:
          buildPrompt(runMode, planCtx) +
          memoryTail +
          (skillIndex ? `\n\n${skillIndex}` : '') +
          (roleIndex ? `\n\n## 可用子 Agent 角色\n${roleIndex}` : ''),
        unknownToolLimit: 2,
        toolsOverride,
        extraSystemMessages: activePrompt ? [activePrompt] : undefined,
        injectSystem: () => pendingSubResults.current.splice(0, pendingSubResults.current.length),
      })
      cancelRef.current = agent.cancel

      // 即时落盘(对齐 Codex rollout JSONL)：每轮结束写增量——崩溃/断电不丢轮
      const appendIncremental = () => {
        if (!memory?.sessionStore || !memory.sessionId || sessionConflict) return
        sessionConflict = tryPersistSessionHistory(memory.sessionStore, memory.sessionId, history, persistenceCursor) === 'conflict'
      }

      const streamBuffer = createStreamBuffer(
        ({ text: textChunk, thinking: thinkingChunk }) => {
          setMessages((prev) => appendStreamChunk(prev, textChunk, thinkingChunk))
        },
        streamFlushDelay(messages.length),
      )
      const eventHandler = createAgentEventHandler({
        stream: streamBuffer,
        planMode: runMode === 'plan',
        persistIncremental: appendIncremental,
        appendAssistant: () => setMessages((prev) => [...prev, { role: 'assistant', text: '', thinking: '' }]),
        appendToolSummary: (summary) => setMessages((prev) => [...prev, { role: 'tool', text: summary }]),
        appendPlanText: (piece) => { planTextRef.current += piece },
        updateProgress: (event) => setRoundInfo({ round: event.round, max: event.max, status: event.status }),
        addUsage: (event) => {
          setTotalTokens((total) => total + event.inputTokens + event.outputTokens)
          if (event.cacheHitTokens !== undefined) setCacheHit((value) => value + event.cacheHitTokens!)
          if (event.cacheMissTokens !== undefined) setCacheMiss((value) => value + event.cacheMissTokens!)
        },
        finish: (event, toolCallCount) => {
          setLastReason(event.reason)
          const reasonError = stopReasonError(event.reason, event.rounds, event.errorMessage)
          if (reasonError) setError(reasonError)
          if (event.reason === 'complete' && toolCallCount === 0 && memory?.noteUserDir && memory?.noteProjectDir) {
            const recent = history.view().slice(-6)
            updateNotes(provider, recent, { userDir: memory.noteUserDir, projectDir: memory.noteProjectDir }).catch(() => {})
          }
        },
      })

      try {
        for await (const ev of agent.events) {
          eventHandler.handle(ev)
        }
      } finally {
        streamBuffer.flush()
        eventHandler.flushTools()
        try {
          await finalizeSend({
            provider,
            history,
            registry,
            ctx,
            memory,
            skillManager,
            hooks,
            startLength: startLen,
            persistenceCursor,
            appendMessage: (message) => setMessages((prev) => [...prev, message]),
            onSessionChange: (sessionId) => {
              switchSessionRuntime(sessionId)
              resetSessionRuntime()
              skillManager?.clear()
            },
          })
        } finally {
          streamBuffer.dispose()
        }
      }
    }
    await runStreamingLifecycle({
      isRunning: () => streamingRef.current,
      start: () => {
        streamingRef.current = true
        cancelRef.current = null
        setMode('streaming')
        setError(null)
        setLastReason(null)
        setRoundInfo(null)
      },
      fail: (failure) => {
        cancelRef.current?.()
        setLastReason('error')
        setError(streamingFailureMessage(failure))
      },
      finish: () => {
        streamingRef.current = false
        cancelRef.current = null
        setMode('idle')
        setRoundInfo(null)
      },
    }, execute)
  }

  const cancel = () => {
    cancelRef.current?.()
  }


  const cacheRate = cacheHit + cacheMiss > 0 ? Math.round((cacheHit / (cacheHit + cacheMiss)) * 100) : null

  // 四模式统一入口：default / edits / plan / yolo
  const [userMode, setUserModeState] = useState<UserMode>('default')

  const setUserMode = (m: UserMode) => {
    if (streamingRef.current) return
    setUserModeState(m)
    const cfg = resolveMode(m)
    setAgentMode(cfg.agentMode)
    setPermModeState(cfg.permMode)
    autoEditsRef.current = cfg.autoEdits
    if (m === 'plan') planTextRef.current = ''
  }

  return {
    messages,
    mode,
    error,
    agentMode,
    roundInfo,
    totalTokens,
    cacheRate,
    lastReason,
    userMode,
    send,
    cancel,
    compact: sessionActions.compact,
    resume: sessionActions.resume,
    listSessions: sessionActions.listSessions,
    deleteSession: sessionActions.deleteSession,
    clearHistory: sessionActions.clearHistory,
    newSession: sessionActions.newSession,
    getToolContext: () => snapshotToolContext(toolContextRef.current),
    isRunning: mode === 'streaming',
    setUserMode,
    isPlan: agentMode === 'plan',
  }
}
