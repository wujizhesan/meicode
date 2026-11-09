import { useEffect, useMemo, useRef, useState } from 'react'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { log } from '../log.ts'
import { createMcpToolRegistrar } from '../mcp/index.ts'
import type { McpClientManager } from '../mcp/index.ts'
import { ContextManager, spillBatch } from '../context/index.ts'
import { buildMemoryTail, captureSessionReportReceipts, createNotesUpdater, createSessionPersistenceCursor, tryPersistSessionHistory } from '../memory/index.ts'
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
import { finalizeSend, persistRemainingHistory } from './send-finalizer.ts'
import { SubAgentResults } from './subagent-results.ts'
import { disposeBrowserScope } from '../tools/browser.ts'
import type { AgentMode, Mode, UIMessage, UserMode } from './types.ts'
import { createSessionActions } from './session-actions.ts'
export type { AgentMode, Mode, UIMessage, UserMode } from './types.ts'

import type { StopReason } from '../agent/events.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import type { AskResult, PermissionMode, ToolCallInfo } from '../permission/types.ts'
import type { RuleEngine } from '../permission/index.ts'
import { reconcileReadyWorkflowRuns } from '../workflow/index.ts'
import { resolveOnAbort } from '../tools/abort.ts'

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
  const subResults = useMemo(() => new SubAgentResults(), [history, subAgentManager])
  const persistence = useMemo(() => ({ cursor: createSessionPersistenceCursor(history) }), [history, memory?.sessionStore])
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
  const notesUpdater = useMemo(createNotesUpdater, [])

  useEffect(() => () => notesUpdater.cancel(), [notesUpdater, provider, history, memory?.sessionId, memory?.noteUserDir, memory?.noteProjectDir])

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
  useEffect(() => () => {
    cancelRef.current?.()
    void disposeBrowserScope(snapshotToolContext(toolContextRef.current))
  }, [])
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
    const receive = (record: Parameters<SubAgentResults['receive']>[0]) => {
      if (disposed) return
      receiveSubResult(record)
    }
    subAgentManager.setOnResult((record) => {
      receive(record)
      void reconcile()
    })
    replaySubResults()
    const timer = setInterval(() => {
      replaySubResults()
      void reconcile()
    }, 5000)
    timer.unref()
    void reconcile()
    return () => {
      disposed = true
      clearInterval(timer)
      subAgentManager.setOnResult(null)
    }
  }, [history, subResults, memory?.runtimeEvents, memory?.sessionId, provider, registry, subAgentManager, teamManager])

  const contextManager = useMemo(
    () => new ContextManager({ provider, history, cwd: process.cwd(), window: contextWindow, hooks: hooks ?? undefined, sessionId: memory?.sessionId, agentId: agentIdRef.current }),
    [provider, history, contextWindow, hooks],
  )
  ctx.spill = (results) => spillBatch(results, process.cwd())
  ctx.contextBudget = () => contextManager.snapshot()
  ctx.setRequestOverhead = (tokens) => contextManager.setRequestOverhead(tokens)
  ctx.beforeRequest = (mode, signal, options) => {
    captureSessionReportReceipts(history, persistence.cursor)
    return contextManager.beforeRequest(mode, signal, options)
  }
  ctx.afterRequest = (usage, count, overhead) => contextManager.afterRequest(usage, count, overhead)

  const receiveSubResult = (record: Parameters<SubAgentResults['receive']>[0], deferFlush = false): void => {
    const text = subResults.receive(record, toolContextRef.current.sessionId, history, memory?.sessionStore)
    if (!text) return
    setMessages((prev) => [...prev, { role: 'tool', text: text.slice(0, 300) }])
    if (!deferFlush && !streamingRef.current) flushSubResults(true)
  }
  const replaySubResults = (): void => {
    try {
      const sessionId = toolContextRef.current.sessionId
      for (const record of subAgentManager?.listRecords(sessionId) ?? []) receiveSubResult(record, true)
      const sources = new Map<string, Set<string>>()
      for (const source of sessionId ? memory?.sessionStore?.getSubAgentTaskSources(sessionId) ?? [] : []) {
        if (source.sessionId === sessionId) continue
        const ids = sources.get(source.sessionId) ?? new Set<string>()
        ids.add(source.agentId)
        sources.set(source.sessionId, ids)
      }
      for (const [sourceSessionId, ids] of sources) {
        for (const record of subAgentManager?.listRecords(sourceSessionId) ?? []) {
          if (ids.has(record.id)) receiveSubResult(record, true)
        }
      }
    } catch (failure) {
      setMessages((prev) => [...prev, { role: 'tool', text: `⚠️ 子任务结果读取失败：${failure instanceof Error ? failure.message : String(failure)}` }])
    } finally {
      if (!streamingRef.current) flushSubResults(true)
    }
  }
  const getConflictTaskSources = () => {
    const current = toolContextRef.current
    return (subAgentManager?.listRecords(current.sessionId) ?? [])
      .filter((record) => record.sessionId && record.parentAgentId === current.agentId)
      .map((record) => ({ sessionId: record.sessionId!, agentId: record.id }))
  }
  const persistCurrentHistory = (force = true): boolean => {
    if (force) persistence.cursor.structureVersion = -1
    return persistRemainingHistory({
      history,
      memory,
      ctx: toolContextRef.current,
      persistenceCursor: persistence.cursor,
      getConflictTaskSources,
      appendMessage: (message) => setMessages((prev) => [...prev, message]),
      onSessionChange: (sessionId) => {
        switchSessionRuntime(sessionId)
        resetSessionRuntime()
        skillManager?.clear()
      },
    })
  }
  const flushSubResults = (persist: boolean): void => {
    const pending = subResults.take()
    if (pending.length === 0) return
    for (const content of pending) history.push({ role: 'system', content })
    if (persist) persistCurrentHistory(false)
  }
  const resetSessionRuntime = (): void => {
    notesUpdater.cancel()
    planTextRef.current = ''
    subResults.clearPending()
    workflowSettledNotices.current.clear()
    void disposeBrowserScope(snapshotToolContext(toolContextRef.current))
  }
  const switchSessionRuntime = (sessionId: string): void => {
    const previous = snapshotToolContext(toolContextRef.current)
    onSessionChange?.(sessionId)
    if (previous.sessionId !== sessionId) {
      void disposeBrowserScope(previous)
      persistence.cursor = createSessionPersistenceCursor(history)
    }
    ctx.sessionId = sessionId
    toolContextRef.current.sessionId = sessionId
    contextManager.setSessionId(sessionId)
  }

  const sessionActions = createSessionActions({
    history,
    memory,
    contextManager,
    skillManager,
    hooks,
    agentId: agentIdRef.current,
    isStreaming: () => streamingRef.current,
    onSessionChange: switchSessionRuntime,
    onResume: () => {
      persistence.cursor = createSessionPersistenceCursor(history)
      subResults.resetForRecovery(toolContextRef.current.sessionId)
      replaySubResults()
    },
    persistHistory: persistCurrentHistory,
    persistBeforeSwitch: () => {
      const cursor = persistence.cursor
      if (cursor.length === history.length && cursor.structureVersion === history.structureVersion) return true
      return persistCurrentHistory(false)
    },
    beforeCompact: () => captureSessionReportReceipts(history, persistence.cursor),
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
    const controller = new AbortController()
    const { signal } = controller
    let executionFailed = false
    const execute = async (): Promise<void> => {
      replaySubResults()
      const runMode = opts?.modeOverride ?? agentMode
      const runSessionId = ctx.sessionId
      let planText = ''
      let runReason: StopReason = 'error'
      if (runMode === 'plan') planTextRef.current = ''
      const persistenceCursor = persistence.cursor
      let sessionConflict = false
      if (opts?.pushUser !== false) {
        setMessages((prev) => [...prev, { role: 'user', text }])
        history.push({ role: 'user', content: text })
      }
      const startLen = history.length
      let streamBuffer: ReturnType<typeof createStreamBuffer> | undefined
      let eventHandler: ReturnType<typeof createAgentEventHandler> | undefined
      try {
        let mcpError: string | null = null
        // 首次发送前懒发现 MCP 远端工具（失败 Server 提示但不阻塞）
        if (mcpRegistrar && !mcpRegistrar.ready) {
          try {
            const result = await resolveOnAbort(() => mcpRegistrar.discover(), signal, null)
            if (!result || signal.aborted) return
            if (result.failed.length > 0) {
              mcpError = `MCP Server 连接失败: ${result.failed.map((f) => `${f.name}（${f.error.slice(0, 60)}）`).join('; ')}`
            }
            if (result.toolCount > 0) {
              // Ink 渲染期间不能写 stdout（会打乱 TUI 布局）——走文件日志保留诊断信息
              log('info', `[MCP] 已接入 ${result.toolCount} 个远端工具（${result.registered.join(', ')}）`)
            }
          } catch (e) {
            mcpError = `MCP 发现失败: ${(e as Error).message}`
          }
        }
        if (signal.aborted) return
        setError(mcpError)

        // 计划文本自动注入：从 plan 切回执行模式后的首次发送，注入后清空
        const planCtx = opts?.planContext ?? (runMode === 'full' && planTextRef.current ? planTextRef.current : undefined)
        if (planCtx && planCtx !== opts?.planContext) planTextRef.current = ''
        // P8：记忆注入（指令 + 索引拼主 system 尾部；索引每次 send 前重读）
        const memoryTail = buildMemoryTail(memory)
        // P10：Skill 激活注入（独立 system 消息，不进稳定前缀）+ 白名单收窄
        // P12：可用子 Agent 角色注入（模型直接知道有哪些角色，避免调查）
        const roleIndex = subAgentManager?.listRoles()
          .map((r) => `- ${r.name}${r.isolation === 'worktree' ? '（隔离 worktree）' : ''}: ${r.description}`)
          .join('\n') ?? ''
        const skillIndex = skillManager?.index() ?? ''
        const resolveRequestOptions = () => {
          const activePrompt = skillManager?.activePrompt() ?? ''
          const activeTools = skillManager?.activeToolNames()
          let toolsOverride: ReturnType<ToolRegistry['toOpenAITools']> | null = null
          if (activeTools) {
            const names = new Set([...activeTools, 'load_skill'])
            toolsOverride = registry.toOpenAITools().filter((tool) => names.has(tool.function.name))
          } else if (teamManager?.isCoordinator()) {
            toolsOverride = teamManager.createLeadTools()
          }
          return { toolsOverride, extraSystemMessages: activePrompt ? [activePrompt] : [] }
        }
        const agent = runAgent({
          provider,
          history,
          registry,
          ctx,
          signal,
          maxIterations: 15,
          mode: runMode,
          systemPrompt:
            buildPrompt(runMode, planCtx) +
            memoryTail +
            (skillIndex ? `\n\n${skillIndex}` : '') +
            (roleIndex ? `\n\n## 可用子 Agent 角色\n${roleIndex}` : ''),
          unknownToolLimit: 2,
          resolveRequestOptions,
          injectSystem: () => subResults.take(),
          persistSystemInjections: true,
          restoreUnsentSystem: (results) => {
            if (toolContextRef.current.sessionId === runSessionId) subResults.restore(results)
          },
        })

        // 即时落盘(对齐 Codex rollout JSONL)：每轮结束写增量——崩溃/断电不丢轮
        const appendIncremental = () => {
          if (!memory?.sessionStore || !memory.sessionId || sessionConflict) return
          sessionConflict = tryPersistSessionHistory(memory.sessionStore, memory.sessionId, history, persistenceCursor) === 'conflict'
        }

        streamBuffer = createStreamBuffer(
          ({ text: textChunk, thinking: thinkingChunk }) => {
            setMessages((prev) => appendStreamChunk(prev, textChunk, thinkingChunk))
          },
          streamFlushDelay(messages.length),
        )
        eventHandler = createAgentEventHandler({
          stream: streamBuffer,
          planMode: runMode === 'plan',
          persistIncremental: appendIncremental,
          appendAssistant: () => setMessages((prev) => [...prev, { role: 'assistant', text: '', thinking: '' }]),
          appendToolSummary: (summary) => setMessages((prev) => [...prev, { role: 'tool', text: summary }]),
          appendPlanText: (piece) => { planText += piece },
          updateProgress: (event) => setRoundInfo({ round: event.round, max: event.max, status: event.status }),
          addUsage: (event) => {
            setTotalTokens((total) => total + event.inputTokens + event.outputTokens)
            if (event.cacheHitTokens !== undefined) setCacheHit((value) => value + event.cacheHitTokens!)
            if (event.cacheMissTokens !== undefined) setCacheMiss((value) => value + event.cacheMissTokens!)
          },
          finish: (event, toolCallCount) => {
            if (event.reason === 'cancelled') controller.abort()
            if (event.reason === 'error') executionFailed = true
            setLastReason(event.reason)
            const reasonError = stopReasonError(event.reason, event.rounds, event.errorMessage)
            if (reasonError) setError(reasonError)
            if (event.reason === 'complete' && toolCallCount === 0 && memory?.noteUserDir && memory?.noteProjectDir) {
              const recent = history.view().slice(-6)
              notesUpdater.start(provider, recent, { userDir: memory.noteUserDir, projectDir: memory.noteProjectDir, signal })
            }
          },
        })

        for await (const ev of agent.events) {
          eventHandler.handle(ev)
        }
        runReason = (await agent.done).reason
      } catch (failure) {
        if (!signal.aborted) executionFailed = true
        controller.abort()
        throw failure
      } finally {
        streamBuffer?.flush()
        eventHandler?.flushTools()
        flushSubResults(false)
        try {
          await finalizeSend({
            provider,
            history,
            registry,
            ctx,
            signal,
            mode: runMode,
            reason: runReason,
            memory,
            skillManager,
            hooks,
            startLength: startLen,
            persistenceCursor,
            getConflictTaskSources,
            appendMessage: (message) => setMessages((prev) => [...prev, message]),
            onSessionChange: (sessionId) => {
              switchSessionRuntime(sessionId)
              resetSessionRuntime()
              skillManager?.clear()
            },
          })
        } finally {
          streamBuffer?.dispose()
        }
      }
      if (runMode === 'plan' && runReason === 'complete' && !signal.aborted && ctx.sessionId === runSessionId) {
        planTextRef.current = planText
      }
    }
    await runStreamingLifecycle({
      isRunning: () => streamingRef.current,
      start: () => {
        notesUpdater.cancel()
        streamingRef.current = true
        cancelRef.current = () => controller.abort()
        setMode('streaming')
        setError(null)
        setLastReason(null)
        setRoundInfo(null)
      },
      fail: (failure) => {
        if (signal.aborted && !executionFailed) {
          setLastReason('cancelled')
        } else {
          executionFailed = true
          controller.abort()
          setLastReason('error')
          setError(streamingFailureMessage(failure))
        }
      },
      finish: () => {
        if (signal.aborted && !executionFailed) {
          setLastReason('cancelled')
          setError(stopReasonError('cancelled', 0))
        }
        streamingRef.current = false
        flushSubResults(true)
        cancelRef.current = null
        setMode('idle')
        setRoundInfo(null)
      },
    }, execute)
  }

  const cancel = () => {
    cancelRef.current?.()
    notesUpdater.cancel()
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
