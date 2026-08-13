import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { ChatView } from './ChatView.tsx'
import { Input } from './Input.tsx'
import { useStreamingChat } from './useStream.ts'
import type { MemoryContext } from './useStream.ts'
import type { SkillManager } from '../skill/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import type { SubAgentManager } from '../subagent/index.ts'
import type { TeamManager } from '../team/index.ts'
import { CommandRegistry, BUILTIN_COMMANDS, createDispatcher } from '../commands/index.ts'
import type { CommandDef, UiController } from '../commands/index.ts'
import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { AskResult, PermissionMode, ToolCallInfo } from '../permission/types.ts'
import type { RuleEngine } from '../permission/index.ts'
import type { McpClientManager } from '../mcp/index.ts'
import { readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listWorkflows, ensureWorkflowDirs, loadWorkflow, WORKFLOW_TEMPLATE } from '../workflow/index.ts'
import { validateWorkflowMeta, runWorkflow } from '../workflow/index.ts'
import { saveRun, listRuns, loadRun } from '../workflow/index.ts'

interface PendingAsk {
  call: ToolCallInfo
  reason?: string
  resolve: (r: AskResult) => void
}

interface PendingElicit {
  question: string
  options: string[]
  resolve: (a: string | null) => void
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
}) {
  const [pendingAsks, setPendingAsks] = useState<PendingAsk[]>([])
  const [compactMsg, setCompactMsg] = useState<string | null>(null)
  const [completeCandidates, setCompleteCandidates] = useState<string[]>([])
  const [completeIdx, setCompleteIdx] = useState(0)

  // 权限询问队列：并发工具调用可能同时触发多个 ask，逐个确认（单槽位会覆盖丢失）
  const ask = (call: ToolCallInfo) =>
    new Promise<AskResult>((resolve) => {
      setPendingAsks((prev) => [...prev, { call, reason: call.reason, resolve }])
    })

  // Elicitation 队列(对齐 Claude Code):agent 提问 → 用户回答注入
  const [pendingElicits, setPendingElicits] = useState<PendingElicit[]>([])
  const elicit = (question: string, options: string[] = []) =>
    new Promise<string | null>((resolve) => {
      setPendingElicits((prev) => [...prev, { question, options, resolve }])
    })

  const stream = useStreamingChat(provider, history, registry, engine, ask, elicit, mcpManager, contextWindow, memory, skillManager, hooks, subAgentManager, teamManager)
  const { messages, mode, error, roundInfo, totalTokens, cacheRate, isRunning, isPlan, userMode } = stream

  // ---------- UiController 实现（命令与渲染解耦） ----------
  const commandRegistry = new CommandRegistry()
  for (const cmd of BUILTIN_COMMANDS) commandRegistry.register(cmd)

  // P10：所有 Skill 启动时直接注册斜杠短命令（执行时自动激活，无需先 /skill 激活）
  for (const s of skillManager?.list() ?? []) {
    try {
      commandRegistry.register({
        name: s.name,
        description: s.description,
        usage: `/${s.name}`,
        type: 'prompt',
        handler: (args, ui) => {
          ui.skillActivate(s.name)
          ui.sendUserMessage(args.length > 0 ? `执行 Skill ${s.name}：${args.join(' ')}` : `执行 Skill ${s.name}`)
        },
      })
    } catch {
      // 命令名冲突跳过（已存在的命令优先）
    }
  }

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
      return `当前模式: ${userMode}\n规则文件: ~/.mewcode/rules.yaml, .mewcode/rules.yaml, .mewcode/rules.local.yaml`
    },
    getStatus: () => {
      const parts = [`模式: ${userMode}`, `Token: ${totalTokens}t`]
      if (cacheRate !== null) parts.push(`缓存命中: ${cacheRate}%`)
      if (roundInfo) parts.push(`轮次: ${roundInfo.round}/${roundInfo.max}`)
      if (memory?.sessionId) parts.push(`会话: ${memory.sessionId}`)
      parts.push(`消息数: ${history.length}`)
      return parts.join('\n')
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
    teamAction: (action, args) => {
      if (!teamManager) return '团队系统未启用'
      try {
        if (action === 'list') {
          const groups = teamManager.listGroups()
          return groups.length ? `小组: ${groups.join(', ')}` : '暂无小组'
        }
        if (action === 'create') {
          const name = args[0]
          if (!name) return '用法: /team create <组名>'
          teamManager.createGroup(name, 'lead')
          return `已创建小组: ${name}`
        }
        if (action === 'spawn') {
          const [group, member, role] = args
          if (!group || !member || !role) return '用法: /team spawn <组> <成员> <角色>'
          const g = teamManager.loadGroup(group)
          if (!g) return `小组不存在: ${group}`
          void teamManager.spawnMember(g, member, role).then(() => {
            setCompactMsg(`已派生成员 ${member}（角色: ${role}）加入小组 ${group}`)
          })
          return `正在派生成员 ${member}（角色: ${role}）...`
        }
        if (action === 'tasks') {
          const group = args[0]
          if (!group) return '用法: /team tasks <组>'
          const tasks = teamManager.listTasks(group)
          return tasks.length ? tasks.map((t) => `  ${t.id} [${t.status}] ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}`).join('\n') : '（无任务）'
        }
        if (action === 'assign') {
          if (args.length < 3) return '用法: /team assign <组> <任务描述> <成员>'
          const [group, member] = [args[0], args[args.length - 1]]
          const title = args.slice(1, -1).join(' ')
          const g = teamManager.loadGroup(group)
          if (!g) return `小组不存在: ${group}`
          const task = teamManager.addTask(group, title, member)
          void teamManager.assignTask(g, task, member).then((r) => setCompactMsg(r))
          return `已创建任务 ${task.id} 并指派 ${member}`
        }
        if (action === 'merge') {
          const group = args[0]
          if (!group) return '用法: /team merge <组>'
          const g = teamManager.loadGroup(group)
          if (!g) return `小组不存在: ${group}`
          void teamManager.mergeAll(g).then((r) => setCompactMsg(r))
          return '开始合并成员 worktree...'
        }
        return `未知操作: ${action}`
      } catch (e) {
        return `团队操作失败: ${(e as Error).message}`
      }
    },
    workflowAction: (action, args) => {
      if (!subAgentManager) return 'Workflow 需要子 agent 系统'
      try {
        const cwd = process.cwd()
        if (action === 'list') {
          const wf = listWorkflows(cwd)
          return wf.length ? `workflows: ${wf.join(', ')}` : '暂无 workflow（/workflow create <名称> 创建）'
        }
        if (action === 'create') {
          const name = args[0]
          if (!name) return '用法: /workflow create <名称>'
          const { project } = ensureWorkflowDirs(cwd)
          const file = join(project, `${name}.workflow.js`)
          if (existsSync(file)) return `已存在: ${file}`
          writeFileSync(file, WORKFLOW_TEMPLATE.replace('NAME', name).replace('DESC', `${name} workflow`), 'utf8')
          return `已创建: ${file}\n编辑后 /workflow validate ${name} 校验`
        }
        if (action === 'validate') {
          const name = args[0]
          if (!name) return '用法: /workflow validate <名称>'
          const p = (async () => {
            try {
              const meta = await loadWorkflow(cwd, name)
              const issues = validateWorkflowMeta(meta)
              setCompactMsg(
                issues.length === 0
                  ? `校验通过: ${meta.name} (${meta.phases.length} phases)`
                  : `校验失败:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
              )
            } catch (e) {
              setCompactMsg(`校验失败: ${(e as Error).message}`)
            }
          })()
          void p
          return `正在校验 ${name}...`
        }
        if (action === 'run') {
          const name = args[0]
          if (!name) return '用法: /workflow run <名称>'
          const p = (async () => {
            try {
              const meta = await loadWorkflow(cwd, name)
              const record = await runWorkflow(meta, {
                provider,
                registry,
                ctx: { cwd },
                subagents: subAgentManager!,
                onProgress: (msg) => setCompactMsg(msg),
              })
              saveRun(cwd, record)
              setCompactMsg(`[workflow] ${meta.name}: ${record.status} — /workflows 查看`)
            } catch (e) {
              setCompactMsg(`[workflow] 运行失败: ${(e as Error).message}`)
            }
          })()
          void p
          return `已启动 workflow ${name}（后台执行，进度见提示）`
        }
        if (action === 'runs') {
          const runs = listRuns(cwd)
          if (!runs.length) return '暂无运行记录'
          return runs
            .map((r) => {
              const done = r.phases.filter((p) => p.status === 'completed').length
              return `  ${r.runId.slice(0, 8)} ${r.workflow.padEnd(16)} ${r.status.padEnd(9)} ${done}/${r.phases.length} ${new Date(r.createdAt).toLocaleTimeString()}`
            })
            .join('\n')
        }
        if (action === 'run-info') {
          const runId = args[0]
          if (!runId) return '用法: /workflows <runId>'
          const rec = loadRun(cwd, runId)
          if (!rec) return `运行不存在: ${runId}`
          return rec.phases
            .map((p) => `  ${p.status.padEnd(9)} ${p.title}${p.artifactPath ? ` → ${p.artifactPath}` : ''}${p.error ? ` (${p.error})` : ''}`)
            .join('\n')
        }
        return '用法: /workflow create|validate|run <名称>'
      } catch (e) {
        return `workflow 操作失败: ${(e as Error).message}`
      }
    },
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
      current.resolve(answer)
      setPendingElicits((prev) => prev.slice(1))
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
      if (pendingAsks.length > 0) {
        const current = pendingAsks[0]
        const done = (r: AskResult) => {
          current.resolve(r)
          setPendingAsks((prev) => prev.slice(1))
        }
        if (key.return) done('once')
        else if (input.toLowerCase() === 's') done('session')
        else if (input.toLowerCase() === 'p') done('forever')
        else if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) done('deny')
        return
      }
      // 补全菜单导航
      if (completeCandidates.length > 0) {
        if (key.upArrow) {
          setCompleteIdx((i) => (i - 1 + completeCandidates.length) % completeCandidates.length)
          return
        }
        if (key.downArrow) {
          setCompleteIdx((i) => (i + 1) % completeCandidates.length)
          return
        }
        if (key.return || input === ' ') {
          setCompleteCandidates([])
          return
        }
        if (key.escape) {
          setCompleteCandidates([])
          return
        }
      }
      if (key.ctrl && input.toLowerCase() === 'c') {
        if (isRunning) stream.cancel()
        else mcpManager?.closeAll().finally(() => process.exit(0))
      }
    },
    { isActive: process.stdin.isTTY === true },
  )

  const currentAsk = pendingAsks[0] ?? null
  const argsBrief = currentAsk ? JSON.stringify(currentAsk.call.args).slice(0, 100) : ''

  return (
    <Box flexDirection="column" paddingX={1}>
      <ChatView messages={messages} mode={mode} />
      {error ? <Text color="red">⚠ {error}</Text> : null}
      {compactMsg ? <Text color="cyan">📦 {compactMsg}</Text> : null}
      {statusLine(userMode, roundInfo, totalTokens, cacheRate) ? (
        <Text dimColor>{statusLine(userMode, roundInfo, totalTokens, cacheRate)}</Text>
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
