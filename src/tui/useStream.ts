import { useRef, useState } from 'react'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { registerMcpTools } from '../mcp/index.ts'
import type { McpClientManager } from '../mcp/index.ts'
import { ContextManager, spillBatch } from '../context/index.ts'
import { updateNotes, buildNotesIndex, newSessionId } from '../memory/index.ts'
import type { SessionStore } from '../memory/index.ts'
import { runIsolated } from '../skill/index.ts'
import type { SkillManager } from '../skill/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import type { SubAgentManager } from '../subagent/index.ts'
import type { TeamManager } from '../team/index.ts'
import { resolveMode } from './mode.ts'
import type { RuntimeEventLog } from '../runtime/index.ts'
import { createRuntimeId } from '../runtime/index.ts'

export interface MemoryContext {
  sessionStore?: SessionStore
  sessionId?: string
  runtimeEvents?: RuntimeEventLog
  instructions?: string
  noteUserDir?: string
  noteProjectDir?: string
}
import type { StopReason } from '../agent/events.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import type { AskResult, PermissionMode, ToolCallInfo } from '../permission/types.ts'
import type { RuleEngine } from '../permission/index.ts'

export interface UIMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  thinking?: string
}

export type Mode = 'idle' | 'streaming' | 'error'
export type AgentMode = 'plan' | 'full'
export type UserMode = 'default' | 'edits' | 'plan' | 'yolo'

export function useStreamingChat(
  provider: Provider,
  history: History,
  registry: ToolRegistry,
  engine: RuleEngine,
  ask: (call: ToolCallInfo) => Promise<AskResult>,
  elicit?: (question: string, options?: string[]) => Promise<string | null>,
  mcpManager?: McpClientManager | null,
  contextWindow = 131072,
  memory?: MemoryContext,
  skillManager?: SkillManager | null,
  hooks?: HookEngine | null,
  subAgentManager?: SubAgentManager | null,
  teamManager?: TeamManager | null,
) {
  // P12：子任务结果回流主对话——不直接插 history（子任务完成时机不可控，
  // 可能落在 assistant(tool_calls) 与 tool 结果之间导致 400）；
  // 改为缓存队列，由 loop 每轮请求前注入为末尾 system（见 loop.ts injectSystem）
  const pendingSubResults = useRef<string[]>([])
  const agentIdRef = useRef(createRuntimeId('agent'))
  subAgentManager?.setOnResult((record) => {
    if (!record.result) return
    const text = `📦 [子任务 ${record.role}] ${record.result}`
    pendingSubResults.current.push(`[子任务 ${record.role} 结果] ${record.result}`)
    setMessages((prev) => [...prev, { role: 'tool', text: text.slice(0, 300) }])
  })
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
  // 工具折叠：本轮工具调用累积与封存
  const roundToolsRef = useRef<{ id: string; name: string; status: 'running' | 'ok' | 'fail' }[]>([])
  const flushRoundToolsRef = useRef<(() => void) | null>(null)

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
  // P7：上下文管理挂钩
  const contextManager = new ContextManager({
    provider,
    history,
    cwd: process.cwd(),
    window: contextWindow,
    hooks: hooks ?? undefined,
  })
  ctx.spill = (results) => spillBatch(results, process.cwd())
  ctx.contextBudget = () => contextManager.snapshot()
  ctx.beforeRequest = (mode) => contextManager.beforeRequest(mode)
  ctx.afterRequest = (usage, count) => contextManager.afterRequest(usage, count)

  // /clear：清空对话历史（存档保留）+ 清除激活 Skill
  const clearHistory = (): void => {
    if (streamingRef.current) return
    history.clear()
    setMessages([])
    setLastReason(null)
    setError(null)
    skillManager?.clear()
  }

  // /session new：新建会话（新 ID，历史清空）
  const newSession = (): string => {
    if (streamingRef.current) return '执行中，无法新建会话'
    history.clear()
    setMessages([])
    setLastReason(null)
    setError(null)
    if (memory) memory.sessionId = newSessionId()
    return '已新建会话'
  }

  // /resume <id>：恢复指定会话（清空当前，替换为该会话历史）
  const resume = (id: string): string => {
    if (streamingRef.current) return '执行中，无法切换会话'
    const recovered = memory?.sessionStore?.recoverById(id)
    if (!recovered) return `未找到会话: ${id}`
    history.clear()
    for (const m of recovered.messages) history.push(m)
    setMessages([])
    setLastReason(null)
    setError(null)
    if (memory) memory.sessionId = id
    return `已恢复会话 ${id}（${recovered.messages.length} 条消息）`
  }

  const listSessions = (): string => {
    const list = memory?.sessionStore?.listSessions(10) ?? []
    if (list.length === 0) return '暂无会话记录'
    const lines = list.map((s) => {
      let date = ''
      if (s.mtime > 0) {
        const d = new Date(s.mtime)
        date = `，${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
      return `  ${s.id}（${s.count} 条${date}）`
    })
    return `会话列表（最近 ${list.length} 个，/session del <id> 删除）:\n` + lines.join('\n')
  }

  const deleteSession = (id: string): string => {
    if (memory?.sessionId === id) return '不能删除当前会话'
    return memory?.sessionStore?.removeById(id) ? `已删除会话 ${id}` : `未找到会话: ${id}`
  }

  // /compact 手动压缩
  const compact = async (): Promise<string> => {
    if (streamingRef.current) return '压缩进行中，请稍候'
    try {
      await contextManager.beforeRequest('manual')
      return contextManager.lastSummary ? '压缩完成：早期对话已摘要' : '无需压缩（未达窗口上限）'
    } catch (e) {
      return `压缩失败: ${(e as Error).message}`
    }
  }

  const updateLast = (fn: (m: UIMessage) => UIMessage) => {
    setMessages((prev) => {
      const next = [...prev]
      next[next.length - 1] = fn(next[next.length - 1])
      return next
    })
  }

  const discoveredRef = useRef(false)

  const send = async (text: string, opts?: { planContext?: string; pushUser?: boolean; modeOverride?: AgentMode }) => {
    if (streamingRef.current) return
    streamingRef.current = true
    // 首次发送前懒发现 MCP 远端工具（失败 Server 提示但不阻塞）
    if (!discoveredRef.current && mcpManager) {
      discoveredRef.current = true
      try {
        const result = await registerMcpTools(registry, mcpManager)
        if (result.failed.length > 0) {
          setError(`MCP Server 连接失败: ${result.failed.map((f) => `${f.name}（${f.error.slice(0, 60)}）`).join('; ')}`)
        }
        if (result.toolCount > 0) {
          console.log(`[MCP] 已接入 ${result.toolCount} 个远端工具（${result.ok.join(', ')}）`)
        }
      } catch (e) {
        setError(`MCP 发现失败: ${(e as Error).message}`)
      }
    }
    cancelRef.current = null
    setMode('streaming')
    setError(null)
    setLastReason(null)
    // 本轮工具累积（折叠展示）：tool_call 累积 → tool_result 更新状态 → 轮末汇总一条
    roundToolsRef.current = []
    flushRoundToolsRef.current = null
    if (opts?.pushUser !== false) {
      setMessages((prev) => [...prev, { role: 'user', text }])
      history.push({ role: 'user', content: text })
    }

    const runMode = opts?.modeOverride ?? agentMode
    // 计划文本自动注入：从 plan 切回执行模式后的首次发送，注入后清空
    const planCtx = opts?.planContext ?? (runMode === 'full' && planTextRef.current ? planTextRef.current : undefined)
    if (planCtx && planCtx !== opts?.planContext) planTextRef.current = ''
    // P8：记忆注入（指令 + 索引拼主 system 尾部；索引每次 send 前重读）
    const memoryTail = memory?.instructions || memory?.noteUserDir || memory?.noteProjectDir
      ? `\n\n## 项目指令\n${memory?.instructions ?? '（无）'}\n\n## 记忆索引\n${
          memory?.noteUserDir && memory?.noteProjectDir
            ? buildNotesIndex(memory.noteUserDir, memory.noteProjectDir)
            : '（无）'
        }`
      : ''
    const startLen = history.length
    let toolCallCount = 0
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

    // 工具折叠封存：把本轮累积的工具调用汇总为一条消息
    flushRoundToolsRef.current = () => {
      const list = roundToolsRef.current
      if (list.length === 0) return
      const parts = list.map((t) => `${t.name}${t.status === 'running' ? '…' : t.status === 'ok' ? ' ✓' : ' ✗'}`)
      setMessages((prev) => [...prev, { role: 'tool', text: `🔧 [${list.length}] ${parts.join(' · ')}` }])
      roundToolsRef.current = []
    }

    // 即时落盘(对齐 Codex rollout JSONL)：每轮结束写增量——崩溃/断电不丢轮
    let appendIdx = startLen
    const appendIncremental = () => {
      if (!memory?.sessionStore || !memory.sessionId) return
      const all = history.all()
      if (appendIdx >= all.length) return
      memory.sessionStore.append(memory.sessionId, all.slice(appendIdx))
      appendIdx = all.length
    }

    try {
      let lastRound = 0
      for await (const ev of agent.events) {
        // 每轮开始：先封存上一轮工具汇总，再 push assistant 占位
        if (ev.type === 'progress' && ev.round !== lastRound) {
          appendIncremental() // 上一轮已完整(assistant+tool 结果)——先落盘
          flushRoundToolsRef.current?.()
          lastRound = ev.round
          setMessages((prev) => [...prev, { role: 'assistant', text: '', thinking: '' }])
        }
        if (ev.type === 'tool_call') toolCallCount++
        if (ev.type === 'text') {
          const piece = ev.text
          if (agentMode === 'plan') planTextRef.current += piece
          updateLast((m) => ({ ...m, text: m.text + piece }))
        } else if (ev.type === 'thinking') {
          const piece = ev.text
          updateLast((m) => ({ ...m, thinking: (m.thinking ?? '') + piece }))
        } else if (ev.type === 'tool_call') {
          // 累积到本轮（折叠展示），不逐行刷屏
          roundToolsRef.current.push({ id: ev.id, name: ev.name, status: 'running' })
        } else if (ev.type === 'tool_result') {
          const t = roundToolsRef.current.find((x) => x.id === ev.id)
          if (t) t.status = ev.success ? 'ok' : 'fail'
        } else if (ev.type === 'progress') {
          setRoundInfo({ round: ev.round, max: ev.max, status: ev.status })
        } else if (ev.type === 'usage') {
          setTotalTokens((t) => t + ev.inputTokens + ev.outputTokens)
          if (ev.cacheHitTokens !== undefined) setCacheHit((v) => v + ev.cacheHitTokens!)
          if (ev.cacheMissTokens !== undefined) setCacheMiss((v) => v + ev.cacheMissTokens!)
        } else if (ev.type === 'done') {
          appendIncremental() // 最后一轮落盘
          flushRoundToolsRef.current?.()
          setLastReason(ev.reason)
          if (ev.reason === 'max_iterations') setError(`达到迭代上限（${ev.rounds} 轮）`)
          else if (ev.reason === 'unknown_tool') setError('连续调用未知工具，已停止')
          else if (ev.reason === 'cancelled') setError('已取消')
          else if (ev.reason === 'tool_failures') setError(ev.errorMessage ?? '工具连续失败，已停止')
          else if (ev.reason === 'error') setError(ev.errorMessage ?? '流错误，已停止')
          // P8：自然停后异步笔记（不阻塞 UI，失败静默）
          if (ev.reason === 'complete' && toolCallCount === 0 && memory?.noteUserDir && memory?.noteProjectDir) {
            const recent = history.all().slice(-6)
            updateNotes(provider, recent, { userDir: memory.noteUserDir, projectDir: memory.noteProjectDir }).catch(() => {})
          }
        }
      }
    } finally {
      // P10：isolated Skill 检测——本轮激活了 isolated 模式 Skill（load_skill 或斜杠命令路径）→ 独立会话 + 摘要回流
      const la = skillManager?.lastActivated
      if (la && la.mode === 'isolated' && skillManager?.isActive(la.name)) {
        const skill = skillManager.get(la.name)
        if (skill) {
          try {
            const skillTools = skill.tools ? new Set([...skill.tools, 'load_skill']) : null
            const summary = await runIsolated(skill, history, {
              provider,
              registry,
              ctx,
              systemPrompt: buildPrompt('full'),
              toolsOverride: skillTools
                ? registry.toOpenAITools().filter((t) => skillTools.has(t.function.name))
                : null,
            })
            history.push({ role: 'system', content: `[Skill ${skill.name} 结果] ${summary}` })
            setMessages((prev) => [...prev, { role: 'tool', text: `📦 [Skill ${skill.name} 结果] ${summary.slice(0, 300)}` }])
          } catch (e) {
            const err = `[Skill ${skill.name} 结果] 执行失败：${(e as Error).message}`
            history.push({ role: 'system', content: err })
            setMessages((prev) => [...prev, { role: 'tool', text: `⚠ ${err}` }])
          }
        }
      }
      if (skillManager) skillManager.lastActivated = null

      // P11：message 事件（本轮新消息）
      const newMsg = history.all().slice(startLen)
      if (newMsg.length > 0) {
        try {
          await hooks?.fire('message', { cwd: process.cwd(), message: newMsg[0] })
        } catch {
          // Hook 失败不中断
        }
      }

      streamingRef.current = false
      cancelRef.current = null
      setMode('idle')
      setRoundInfo(null)
      // P8：会话存档（增量 JSONL 追加——即时落盘已写大部分,这里兜底剩余）
      if (memory?.sessionStore && memory.sessionId) {
        try {
          const all = history.all()
          if (appendIdx < all.length) memory.sessionStore.append(memory.sessionId, all.slice(appendIdx))
        } catch {
          // 存档失败静默
        }
      }
    }
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
    compact,
    resume,
    listSessions,
    deleteSession,
    clearHistory,
    newSession,
    isRunning: mode === 'streaming',
    setUserMode,
    isPlan: agentMode === 'plan',
  }
}
