import type { Provider } from '../provider/types.ts'
import { History } from '../session/history.ts'
import type { ToolContext, ToolRegistry, Tool } from '../tools/index.ts'
import { runAgent } from '../agent/loop.ts'
import type { AgentHandle } from '../agent/events.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { loadAgentRoles } from './loader.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import type { AgentRole, SpawnRequest, SubAgentRecord } from './types.ts'
import type { SubAgentStore } from './store.ts'
import { collectRuntimeEvidence, createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'

const SYSTEM_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'grep_code', 'load_skill', 'spawn_agent'])

function summarizeLocally(text: string, limit = 500): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  const head = Math.floor(limit * 0.72)
  const tail = limit - head - 5
  return `${normalized.slice(0, head)} ... ${normalized.slice(-tail)}`
}

function emitRuntimeEvent(ctx: ToolContext, input: Omit<RuntimeEventInput, 'sessionId'>): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.append({ ...input, sessionId })
  } catch {
  }
}
const SYNC_MAX_WAIT = 30000 // 同步等待上限，超时转后台

export class SubAgentManager {
  private roles = new Map<string, AgentRole>()
  private records = new Map<string, SubAgentRecord>()
  private onResult: ((record: SubAgentRecord) => void) | null = null
  private dirs: { builtin: string; user: string; project: string }
  private worktrees: WorktreeManager | null = null
  private store: SubAgentStore | null = null
  private activeAgents = new Map<string, AgentHandle>()
  private activeRuns = new Map<string, Promise<unknown>>()
  private closed = false

  constructor(dirs: { builtin: string; user: string; project: string }, worktrees?: WorktreeManager | null, store?: SubAgentStore | null) {
    this.dirs = dirs
    this.worktrees = worktrees ?? null
    this.store = store ?? null
    for (const record of this.store?.load() ?? []) {
      if (record.status === 'running') {
        record.status = 'error'
        record.error = '进程重启时子 Agent 中断'
        record.finishedAt = Date.now()
        record.updatedAt = record.finishedAt
        this.store?.save(record)
      }
      this.records.set(record.id, record)
    }
  }

  private persistRecord(record: SubAgentRecord): void {
    record.updatedAt = Date.now()
    this.store?.save(record)
  }

  private markError(record: SubAgentRecord, ctx: ToolContext, req: SpawnRequest, error: unknown): void {
    record.status = 'error'
    record.error = error instanceof Error ? error.message : String(error)
    record.finishedAt = Date.now()
    this.persistRecord(record)
    emitRuntimeEvent(ctx, {
      type: 'subagent_finished',
      agentId: record.id,
      taskId: req.taskId,
      payload: { status: record.status, error: record.error },
    })
    this.onResult?.(record)
  }

  loadRoles(): void {
    this.roles.clear()
    for (const role of loadAgentRoles(this.dirs)) this.roles.set(role.name, role)
  }

  getRole(name: string): AgentRole | undefined {
    return this.roles.get(name)
  }

  listRoles(): AgentRole[] {
    return [...this.roles.values()]
  }

  listRecords(): SubAgentRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  getRecord(id: string): SubAgentRecord | undefined {
    return this.records.get(id)
  }

  setOnResult(cb: (record: SubAgentRecord) => void): void {
    this.onResult = cb
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true
    for (const agent of this.activeAgents.values()) agent.cancel()
    if (this.activeRuns.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.activeRuns.values()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // 工具过滤（多层防线）：白名单/父工具 → 黑名单 → spawn_agent 默认移除 → 系统工具保留
  filterTools(role: AgentRole | undefined, parentTools?: Tool[]): string[] {
    let base: string[]
    if (role?.toolsAllow?.length) {
      base = [...role.toolsAllow]
    } else if (parentTools?.length) {
      base = parentTools.map((t) => t.name)
    } else {
      base = [...SYSTEM_TOOLS].filter((t) => t !== 'spawn_agent')
    }
    // 黑名单
    if (role?.toolsDeny?.length) {
      base = base.filter((t) => !role.toolsDeny!.includes(t))
    }
    // 全局禁止：spawn_agent 默认移除（角色白名单显式含才保留）
    if (!role?.toolsAllow?.includes('spawn_agent')) {
      base = base.filter((t) => t !== 'spawn_agent')
    }
    // 系统工具始终保留（黑名单优先，不覆盖 toolsDeny）
    for (const t of SYSTEM_TOOLS) {
      if (t !== 'spawn_agent' && !base.includes(t) && !role?.toolsDeny?.includes(t)) base.push(t)
    }
    return base
  }

  async spawn(
    req: SpawnRequest,
    opts: {
      provider: Provider
      registry: ToolRegistry
      ctx: ToolContext
    },
  ): Promise<{ id: string; syncResult?: string; async: boolean }> {
    if (this.closed) return { id: '', async: false, syncResult: 'SubAgentManager 已关闭' }
    const role = req.type === 'defined' ? this.roles.get(req.role ?? '') : undefined
    if (req.type === 'defined' && !role) {
      return { id: '', async: false, syncResult: `未找到角色: ${req.role}` }
    }

    const id = createRuntimeId('agent')
    const record: SubAgentRecord = {
      id,
      role: req.role ?? 'fork',
      type: req.type,
      status: 'running',
      sessionId: opts.ctx.sessionId,
      parentAgentId: req.parentAgentId ?? opts.ctx.agentId,
      taskId: req.taskId,
      startedAt: Date.now(),
    }
    this.records.set(id, record)
    this.persistRecord(record)
    emitRuntimeEvent(opts.ctx, {
      type: 'subagent_started',
      agentId: id,
      taskId: req.taskId,
      payload: { role: req.role ?? 'fork', type: req.type },
    })
    // subagent_start hook：子任务启动通知（审计/监控）
    void opts.ctx.hooks?.fire('subagent_start', {
      cwd: opts.ctx.cwd,
      agentId: id,
      role: req.role ?? 'fork',
    })

    const toolNames = this.filterTools(role, req.parentTools)
    const run = async (): Promise<string> => {
      const sub = new History()
      if (req.type === 'fork') {
        for (const m of (req.parentHistory ?? []).slice(-10)) sub.push(m)
      }
      sub.push({ role: 'user', content: req.prompt })

      const maxRounds = role?.maxRounds ?? 10
      const subCtx: ToolContext = { ...opts.ctx, agentId: id, ...(req.taskId ? { taskId: req.taskId } : {}) }
      if (role?.permission && subCtx.permission) {
        subCtx.permission = { ...subCtx.permission, mode: role.permission }
      }

      // P13：worktree 隔离——isolation: worktree 角色在独立目录执行（explicit cwd）
      let wtPath: string | null = null
      let wtBranch: string | null = null
      let worktreeClosed = false
      if (role?.isolation === 'worktree') {
        if (!this.worktrees) throw new Error('子Agent 要求 worktree 隔离，但当前未配置 WorktreeManager')
        try {
          const wt = await this.worktrees.create(role.name)
          wtPath = wt.path
          wtBranch = wt.branch
          subCtx.cwd = wt.path // explicit cwd：所有工具调用基于 worktree 路径
        } catch (e) {
          throw new Error(`子Agent worktree 创建失败，已拒绝无隔离执行: ${(e as Error).message}`)
        }
      }

      const cleanupWorktree = async (summary?: string): Promise<void> => {
        if (worktreeClosed || !wtPath || !role || !this.worktrees) return
        worktreeClosed = true
        try {
          const info = await this.worktrees.exit(role.name)
          if (info.dirty) {
            if (summary !== undefined) record.result = `${summary}\n（worktree 保留待合并: ${info.path}，分支 ${info.branch}）`
          } else {
            await this.worktrees.remove(role.name)
          }
        } catch (e) {
          console.warn(`[子Agent] worktree 收尾失败: ${(e as Error).message}`)
        }
      }

      try {
      const toolsOverride = opts.registry
        .toOpenAITools()
        .filter((t) => toolNames.includes(t.function.name))

      const systemPrompt = role ? role.content : buildPrompt('full')
      const systemWithCtx = wtPath
        ? `${systemPrompt}\n\n工作目录：${wtPath}（隔离 worktree，分支 ${wtBranch}）。所有文件操作都发生在该目录，不要访问外部路径。`
        : systemPrompt

      const agent = runAgent({
        provider: opts.provider,
        history: sub,
        registry: opts.registry,
        ctx: subCtx,
        maxIterations: maxRounds,
        mode: 'full',
        systemPrompt: systemWithCtx,
        unknownToolLimit: 2,
        toolsOverride,
      })
      this.activeAgents.set(id, agent)

      const outputParts: string[] = []
      try {
        for await (const ev of agent.events) {
          if (ev.type === 'text') outputParts.push(ev.text)
        }
      } finally {
        this.activeAgents.delete(id)
      }
      const output = outputParts.join('')
      const result = await agent.done
      const toolOut = sub
        .all()
        .filter((m) => m.role === 'tool')
        .map((m) => m.content)
        .join('\n')
      const combined = [output, toolOut].filter(Boolean).join('\n\n---\n\n')

      const summary = summarizeLocally(combined || output || '子任务已完成')

      record.status = result.reason === 'error' || result.reason === 'tool_failures'
        ? 'error'
        : result.reason === 'cancelled'
          ? 'cancelled'
          : 'done'
      record.finishedAt = Date.now()
      record.tokens = result.totalTokens
      record.reportId = createRuntimeId('report')
      record.result = summary
      record.evidence = collectRuntimeEvidence(opts.ctx.runtimeEvents?.read(opts.ctx.sessionId ?? id) ?? [], id, record.startedAt)
      if (record.status === 'error') record.error = result.reason
      this.persistRecord(record)
      emitRuntimeEvent(opts.ctx, {
        type: 'subagent_finished',
        agentId: id,
        taskId: req.taskId,
        payload: { status: record.status, tokens: record.tokens, error: record.error },
      })
      // subagent_stop hook：子任务结束通知（含耗时/token/状态）
      void opts.ctx.hooks?.fire('subagent_stop', {
        cwd: opts.ctx.cwd,
        agentId: id,
        role: req.role ?? 'fork',
        stats: `status=${record.status} tokens=${record.tokens} duration=${((Date.now() - record.startedAt) / 1000).toFixed(1)}s`,
      })

      // P13：worktree 完成后处理——dirty 保留待合并 / 干净清理
      await cleanupWorktree(summary)
      if (!worktreeClosed && wtPath && role && this.worktrees) {
        try {
          const info = await this.worktrees.exit(role.name)
          if (info.dirty) {
            record.result = `${summary}\n（worktree 保留待合并: ${info.path}，分支 ${info.branch}）`
          } else {
            await this.worktrees.remove(role.name)
          }
        } catch (e) {
          console.warn(`[子Agent] worktree 收尾失败: ${(e as Error).message}`)
        }
      }

      this.persistRecord(record)
      this.onResult?.(record)
      return summary
      } catch (error) {
        await cleanupWorktree()
        throw error
      }
    }

    // 后台分流：显式 async 或 fork 强制后台
    if (req.async || req.type === 'fork') {
      const execution = run().catch((e) => {
        this.markError(record, opts.ctx, req, e)
      })
      this.activeRuns.set(id, execution)
      void execution.then(() => this.activeRuns.delete(id), () => this.activeRuns.delete(id))
      return { id, async: true }
    }

    // 同步等待（30s 上限，超时转后台）
    let timeout: ReturnType<typeof setTimeout> | undefined
    let syncResult: string
    const execution = run().catch((e) => {
      this.markError(record, opts.ctx, req, e)
      throw e
    })
    this.activeRuns.set(id, execution)
    void execution.then(() => this.activeRuns.delete(id), () => this.activeRuns.delete(id))
    try {
      syncResult = await Promise.race([
        execution,
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => {
            resolve('__TIMEOUT__')
          }, SYNC_MAX_WAIT)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (syncResult === '__TIMEOUT__') {
      return { id, async: true }
    }
    return { id, syncResult, async: false }
  }
}
