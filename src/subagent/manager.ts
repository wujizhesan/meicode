import type { Provider, ChatMessage } from '../provider/types.ts'
import { History } from '../session/history.ts'
import type { ToolContext, ToolRegistry, Tool } from '../tools/index.ts'
import { runAgent } from '../agent/loop.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { loadAgentRoles } from './loader.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import type { AgentRole, SpawnRequest, SubAgentRecord } from './types.ts'

const SYSTEM_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'grep_code', 'load_skill', 'spawn_agent'])
const SYNC_MAX_WAIT = 30000 // 同步等待上限，超时转后台

export class SubAgentManager {
  private roles = new Map<string, AgentRole>()
  private records = new Map<string, SubAgentRecord>()
  private onResult: ((record: SubAgentRecord) => void) | null = null
  private dirs: { builtin: string; user: string; project: string }
  private worktrees: WorktreeManager | null = null

  constructor(dirs: { builtin: string; user: string; project: string }, worktrees?: WorktreeManager | null) {
    this.dirs = dirs
    this.worktrees = worktrees ?? null
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
    const role = req.type === 'defined' ? this.roles.get(req.role ?? '') : undefined
    if (req.type === 'defined' && !role) {
      return { id: '', async: false, syncResult: `未找到角色: ${req.role}` }
    }

    const id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const record: SubAgentRecord = {
      id,
      role: req.role ?? 'fork',
      type: req.type,
      status: 'running',
      startedAt: Date.now(),
    }
    this.records.set(id, record)
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
      const subCtx: ToolContext = { ...opts.ctx }
      if (role?.permission && subCtx.permission) {
        subCtx.permission = { ...subCtx.permission, mode: role.permission }
      }

      // P13：worktree 隔离——isolation: worktree 角色在独立目录执行（explicit cwd）
      let wtPath: string | null = null
      let wtBranch: string | null = null
      if (role?.isolation === 'worktree' && this.worktrees) {
        try {
          const wt = await this.worktrees.create(role.name)
          wtPath = wt.path
          wtBranch = wt.branch
          subCtx.cwd = wt.path // explicit cwd：所有工具调用基于 worktree 路径
        } catch (e) {
          console.warn(`[子Agent] worktree 创建失败，降级为不隔离: ${(e as Error).message}`)
        }
      }

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

      let output = ''
      for await (const ev of agent.events) {
        if (ev.type === 'text') output += ev.text
      }
      const result = await agent.done
      const toolOut = sub
        .all()
        .filter((m) => m.role === 'tool')
        .map((m) => m.content)
        .join('\n')
      const combined = [output, toolOut].filter(Boolean).join('\n\n---\n\n')

      // LLM 摘要
      let summary = output.slice(0, 500)
      if (combined) {
        const msgs: ChatMessage[] = [
          { role: 'system', content: '把下面的子任务执行输出压缩成 200 字以内的中文摘要，保留关键结论与数字。只输出摘要正文。' },
          { role: 'user', content: combined.slice(-8000) },
        ]
        let s = ''
        for await (const ev of opts.provider.streamChat(msgs, { thinking: false })) {
          if (ev.type === 'text') s += ev.text
        }
        if (s.trim()) summary = s.trim()
      }

      record.status = result.reason === 'error' || result.reason === 'tool_failures' ? 'error' : 'done'
      record.finishedAt = Date.now()
      record.tokens = result.totalTokens
      record.result = summary
      if (record.status === 'error') record.error = result.reason
      // subagent_stop hook：子任务结束通知（含耗时/token/状态）
      void opts.ctx.hooks?.fire('subagent_stop', {
        cwd: opts.ctx.cwd,
        agentId: id,
        role: req.role ?? 'fork',
        stats: `status=${record.status} tokens=${record.tokens} duration=${((Date.now() - record.startedAt) / 1000).toFixed(1)}s`,
      })

      // P13：worktree 完成后处理——dirty 保留待合并 / 干净清理
      if (wtPath && role && this.worktrees) {
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

      this.onResult?.(record)
      return summary
    }

    // 后台分流：显式 async 或 fork 强制后台
    if (req.async || req.type === 'fork') {
      void run().catch((e) => {
        record.status = 'error'
        record.error = (e as Error).message
        record.finishedAt = Date.now()
        this.onResult?.(record)
      })
      return { id, async: true }
    }

    // 同步等待（30s 上限，超时转后台）
    const syncResult = await Promise.race([
      run(),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          // 超时：记录已在 run 中继续——返回占位（run 完成时会回调 onResult）
          resolve('__TIMEOUT__')
        }, SYNC_MAX_WAIT),
      ),
    ])
    if (syncResult === '__TIMEOUT__') {
      return { id, async: true }
    }
    return { id, syncResult, async: false }
  }
}
