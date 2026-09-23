import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { ChatView } from './ChatView.tsx'
import { Input } from './Input.tsx'
import { useStreamingChat } from './useStream.ts'
import type { MemoryContext } from '../memory/index.ts'
import type { SkillManager } from '../skill/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import type { SubAgentManager } from '../subagent/index.ts'
import type { TeamManager } from '../team/index.ts'
import { createDispatcher } from '../commands/index.ts'
import type { UiController } from '../commands/index.ts'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { RuntimeEvent } from '../runtime/index.ts'
import type { AskResult, ToolCallInfo } from '../permission/types.ts'
import type { RuleEngine } from '../permission/index.ts'
import type { McpClientManager } from '../mcp/index.ts'
import { readdirSync, existsSync } from 'node:fs'
import { createAppCommandRegistry } from './command-registry.ts'
import { createTeamAction, createWorkflowAction } from './command-actions.ts'
import { InteractionQueue } from './interaction-queue.ts'
import { moveCompletionIndex, selectedCompletion } from './completion.ts'
import type { CompletionRequest } from './completion.ts'

interface PendingAsk {
  call: ToolCallInfo
  reason?: string
}

interface PendingElicit {
  question: string
  options: string[]
}

export function App({
  provider,
  history,
  registry,
  engine,
  mcpManager,
  contextWindow,
  memory,
  skillManager,
  hooks,
  subAgentManager,
  teamManager,
  onSessionChange,
}: {
  provider: Provider
  history: History
  registry: ToolRegistry
  engine: RuleEngine
  mcpManager?: McpClientManager | null
  contextWindow?: number
  memory?: MemoryContext
  skillManager?: SkillManager | null
  hooks?: HookEngine | null
  subAgentManager?: SubAgentManager | null
  teamManager?: TeamManager | null
  onSessionChange?: (sessionId: string) => void
}) {
  const { exit } = useApp()
  const askQueue = useMemo(() => new InteractionQueue<PendingAsk, AskResult>(), [])
  const elicitQueue = useMemo(() => new InteractionQueue<PendingElicit, string | null>(), [])
  const [pendingAsks, setPendingAsks] = useState<PendingAsk[]>([])
  const [pendingElicits, setPendingElicits] = useState<PendingElicit[]>([])
  const [compactMsg, setCompactMsg] = useState<string | null>(null)
  const [completeCandidates, setCompleteCandidates] = useState<string[]>([])
  const [completeIdx, setCompleteIdx] = useState(0)
  const [completionRequest, setCompletionRequest] = useState<CompletionRequest | null>(null)
  const [inputEditing, setInputEditing] = useState(false)

  useEffect(() => {
    const unsubscribeAsk = askQueue.subscribe(setPendingAsks)
    const unsubscribeElicit = elicitQueue.subscribe(setPendingElicits)
    return () => {
      unsubscribeAsk()
      unsubscribeElicit()
      askQueue.resolveAll('deny')
      elicitQueue.resolveAll(null)
    }
  }, [askQueue, elicitQueue])

  const ask = (call: ToolCallInfo, signal?: AbortSignal) => askQueue.request(
    { call, reason: call.reason },
    signal ? { signal, response: 'deny' } : undefined,
  )
  const elicit = (question: string, options: string[] = [], signal?: AbortSignal) => elicitQueue.request(
    { question, options },
    signal ? { signal, response: null } : undefined,
  )

  const stream = useStreamingChat(provider, history, registry, engine, ask, elicit, mcpManager, contextWindow, memory, skillManager, hooks, subAgentManager, teamManager, onSessionChange)
  const { messages, mode, error, roundInfo, totalTokens, cacheRate, isRunning, isPlan, userMode } = stream

  // ---------- UiController 实现（命令与渲染解耦） ----------
  const commandRegistry = useMemo(() => createAppCommandRegistry(skillManager), [skillManager])

  const ui: UiController = {
    showMessage: (text) => setCompactMsg(text),
    sendUserMessage: (text) => {
      void stream.send(text)
    },
    setMode: (m) => {
      if (m === 'default' || m === 'edits' || m === 'plan' || m === 'yolo') {
        stream.setUserMode(m as 'default' | 'edits' | 'plan' | 'yolo')
      }
    },
    clearHistory: () => stream.clearHistory(),
    compact: () => stream.compact(),
    snapshotAction: async (action, arg) => {
      // 快照/回滚(工具在 registry,直接执行)
      const tool = action === 'snapshot' ? registry.get('snapshot') : registry.get('rollback')
      if (!tool) return '快照工具不可用'
      const args: Record<string, unknown> = {}
      if (action === 'snapshot') args.label = arg || undefined
      else {
        const [tag, act] = (arg ?? '').split(' ')
        args.tag = tag ?? ''
        args.action = act ?? 'stage'
      }
      const r = await tool.execute(args, { cwd: process.cwd() })
      return r.success ? r.output : (r.error ?? '操作失败')
    },
    sessionAction: (action, arg) => {
      if (action === 'list') return stream.listSessions()
      if (action === 'new') return stream.newSession()
      if (action === 'del') return stream.deleteSession(arg ?? '')
      return stream.resume(arg ?? '')
    },
    memoryList: () => {
      const dirs = [memory?.noteProjectDir, memory?.noteUserDir].filter((d): d is string => !!d)
      const lines: string[] = []
      for (const dir of dirs) {
        if (!existsSync(dir)) continue
        const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md')
        lines.push(`${dir}：${files.length} 条笔记`)
        for (const f of files.slice(0, 10)) lines.push(`  ${f}`)
      }
      return lines.length > 0 ? lines.join('\n') : '暂无笔记'
    },
    permissionSummary: () => {
      return `当前模式: ${userMode}\n规则文件: ~/.meicode/rules.yaml, .meicode/rules.yaml, .meicode/rules.local.yaml`
    },
    getStatus: () => {
      const parts = [`模式: ${userMode}`, `Token: ${totalTokens}t`]
      if (cacheRate !== null) parts.push(`缓存命中: ${cacheRate}%`)
      if (roundInfo) parts.push(`轮次: ${roundInfo.round}/${roundInfo.max}`)
      if (memory?.sessionId) parts.push(`会话: ${memory.sessionId}`)
      parts.push(`消息数: ${history.length}`)
      return parts.join('\n')
    },
    auditAction: (args) => {
      const rawLimit = args.at(-1)
      const limit = rawLimit && /^\d+$/.test(rawLimit) ? Math.min(100, Math.max(1, Number(rawLimit))) : 20
      let filterLabel = ''
      let predicate: ((event: RuntimeEvent) => boolean) | undefined
      if (args[0] === 'task' || args[0] === 'request') {
        const value = args[1]
        if (!value) return '用法: /audit task <taskId> [limit] 或 /audit request <requestId> [limit]'
        predicate = args[0] === 'task'
          ? (event) => event.taskId === value
          : (event) => event.correlationId === value || event.payload?.requestId === value
        filterLabel = `${args[0]}=${value}`
      } else if (args[0] && !/^\d+$/.test(args[0])) {
        predicate = (event) => event.payload?.kind === args[0]
        filterLabel = `kind=${args[0]}`
      }
      const events = memory?.runtimeEvents?.tail(memory.sessionId ?? '', { type: 'audit', limit, predicate }) ?? []
      if (events.length === 0) return '暂无审计事件'
      const lines = events.map((event) => {
        const payload = event.payload ?? {}
        const kind = String(payload.kind ?? event.type)
        const links = [event.taskId ? `task=${event.taskId}` : '', event.correlationId ? `request=${event.correlationId}` : '', event.agentId ? `agent=${event.agentId}` : ''].filter(Boolean).join(' ')
        const details = JSON.stringify(payload)
        return `${event.seq} ${new Date(event.ts).toLocaleTimeString()} ${kind}${links ? ` ${links}` : ''}${details !== '{}' ? ` ${details.slice(0, 240)}` : ''}`
      })
      return `审计事件${filterLabel ? `（${filterLabel}）` : ''}，最近 ${events.length} 条：\n${lines.join('\n')}`
    },
    listCommands: (includeHidden) => commandRegistry.list(includeHidden),
    skillList: () => {
      if (!skillManager) return 'Skill 系统未启用'
      const lines = skillManager.index().split('\n')
      const active = skillManager.activeToolNames() !== null
      return lines.length > 1 ? lines.join('\n') + (active ? '\n（当前有激活 Skill）' : '') : '暂无可用 Skills'
    },
    skillActivate: (name) => (skillManager ? skillManager.activate(name) : 'Skill 系统未启用'),
    skillDeactivate: (name) => {
      if (!skillManager) return 'Skill 系统未启用'
      skillManager.deactivate(name)
      return `已停用 Skill: ${name}`
    },
    teamAction: createTeamAction(teamManager, setCompactMsg),
    workflowAction: createWorkflowAction({
      cwd: process.cwd(),
      provider,
      registry,
      subAgentManager,
      teamManager,
      getContext: stream.getToolContext,
      notify: setCompactMsg,
    }),
  }

  const dispatcher = createDispatcher(commandRegistry, ui)

  // ---------- 输入处理 ----------
  const handleSend = (text: string) => {
    // Elicitation 优先：agent 提问等待时,输入作为回答
    if (pendingElicits.length > 0) {
      const current = pendingElicits[0]
      const trimmed = text.trim()
      if (!trimmed) return
      // 选项快速选择:输入数字或直接匹配选项
      const idx = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1
      const answer = idx >= 0 && idx < current.options.length ? current.options[idx] : trimmed
      elicitQueue.resolveNext(answer)
      return
    }
    // Skill 名引导：输入 /review 但它是 Skill 不是命令 → 提示激活方式
    if (text.startsWith('/')) {
      const name = text.slice(1).split(/\s+/)[0].toLowerCase()
      if (skillManager?.get(name) && !commandRegistry.find(name)) {
        setCompactMsg(`「${name}」是 Skill 不是命令——/skill ${name} 激活，或直接说「用 ${name}」`)
        return
      }
    }
    if (dispatcher.dispatch(text)) return
    stream.send(text)
  }

  // Tab 补全
  const handleTabComplete = (value: string): string | null => {
    if (!value.startsWith('/')) return null
    const prefix = value.toLowerCase()
    const candidates = dispatcher.complete(prefix)
    if (candidates.length === 0) return null
    if (candidates.length === 1) return `/${candidates[0]} `
    setCompleteCandidates(candidates.map((c) => `/${c}`))
    setCompleteIdx(0)
    return null
  }

  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'c') {
        if (isRunning) {
          stream.cancel()
          askQueue.resolveAll('deny')
          elicitQueue.resolveAll(null)
        } else {
          exit()
        }
        return
      }
      if (pendingAsks.length > 0) {
        const done = (r: AskResult) => {
          askQueue.resolveNext(r)
        }
        if (key.return) done('once')
        else if (input.toLowerCase() === 's') done('session')
        else if (input.toLowerCase() === 'p') done('forever')
        else if (key.escape) done('deny')
        return
      }
      // 补全菜单导航
      if (completeCandidates.length > 0) {
        if (key.upArrow) {
          setCompleteIdx((index) => moveCompletionIndex(index, completeCandidates.length, -1))
          return
        }
        if (key.downArrow) {
          setCompleteIdx((index) => moveCompletionIndex(index, completeCandidates.length, 1))
          return
        }
        if (key.return || input === ' ') {
          setCompletionRequest(selectedCompletion(completeCandidates, completeIdx))
          setCompleteCandidates([])
          return
        }
        if (key.escape) {
          setCompleteCandidates([])
          return
        }
      }
    },
    { isActive: process.stdin.isTTY === true },
  )

  const currentAsk = pendingAsks[0] ?? null
  const argsBrief = currentAsk ? JSON.stringify(currentAsk.call.args).slice(0, 100) : ''

  const status = statusLine(userMode, roundInfo, totalTokens, cacheRate)

  return (
    <Box flexDirection="column" paddingX={1}>
      <ChatView messages={messages} mode={mode} compact={inputEditing} />
      {error ? <Text color="red">⚠ {error}</Text> : null}
      {compactMsg ? <Text color="cyan">📦 {compactMsg}</Text> : null}
      {status ? (
        <Text dimColor>{status}</Text>
      ) : null}
      {isPlan ? <Text dimColor>计划模式：仅读类工具，/do 切回执行</Text> : null}
      {completeCandidates.length > 0 ? (
        <Box flexDirection="column">
          {completeCandidates.map((c, i) => (
            <Text key={c} color={i === completeIdx ? 'cyan' : undefined}>
              {i === completeIdx ? '❯ ' : '  '}
              {c}
            </Text>
          ))}
        </Box>
      ) : null}
      {pendingElicits.length > 0 ? (
        <Text color="cyan">
          ❓ {pendingElicits[0].question}
          {pendingElicits[0].options.length > 0
            ? `\n  ${pendingElicits[0].options.map((o, i) => `${i + 1}. ${o}`).join('  ')}`
            : ''}
          {pendingElicits.length > 1 ? `  [还有 ${pendingElicits.length - 1} 个问题]` : ''}
          {'\n（直接输入回答,或输入选项数字）'}
        </Text>
      ) : null}
      {currentAsk ? (
        <Text color="yellow">
          ⚠ 权限请求: {currentAsk.call.name}({argsBrief}){currentAsk.reason ? `\n  ${currentAsk.reason}` : ''}（Enter 本次 / S 会话 / P 永久 / Esc 拒绝）
          {pendingAsks.length > 1 ? `  [队列还有 ${pendingAsks.length - 1} 个]` : ''}
        </Text>
      ) : (
        <Input
          onSend={handleSend}
          onTabComplete={handleTabComplete}
          disabled={isRunning}
          menuOpen={completeCandidates.length > 0}
          completionRequest={completionRequest}
          onCompletionApplied={() => setCompletionRequest(null)}
          onEditingChange={setInputEditing}
          placeholder={isRunning ? '执行中…（Ctrl+C 取消）' : undefined}
        />
      )}
    </Box>
  )
}

function statusLine(
  userMode: string,
  roundInfo: { round: number; max: number } | null,
  totalTokens: number,
  cacheRate: number | null,
): string {
  const label: Record<string, string> = { default: 'Default', edits: 'Edits', plan: 'Plan', yolo: 'YOLO' }
  return [label[userMode] ? `[${label[userMode]}]` : '', roundInfo ? `${roundInfo.round}/${roundInfo.max}` : '', totalTokens > 0 ? `⚡${totalTokens}t` : '', cacheRate !== null ? `缓存${cacheRate}%` : '']
    .filter(Boolean)
    .join(' ')
}
