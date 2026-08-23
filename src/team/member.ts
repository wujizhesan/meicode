import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../provider/types.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import type { AgentHandle } from '../agent/events.ts'
import { summarize, tailKeep, summaryMessage, boundaryMessage } from '../context/summary.ts'
import type { TeamGroupStore } from './group.ts'
import type { TeamMail } from './mail.ts'
import type { TeamMember, TeamTaskReport } from './types.ts'
import { collectRuntimeEvidence, createRuntimeId } from '../runtime/index.ts'

// 成员上下文压缩阈值:历史估算超限时,摘要早期对话(对齐主会话 compact)
// 大任务几十轮后成员历史无限累积——不压缩会上下文爆炸
const MEMBER_COMPACT_CHARS = 80000 // ≈20K tokens

const MEMBER_SYSTEM = `你是团队成员。使用团队协作工具（team_task 查看任务/汇报状态，team_send 与 Lead 和其他成员通信）。
任务执行完成后发送 IDLE 消息给 Lead（team_send to=Lead body=IDLE 完成摘要）。
需要审批时：先发 PLAN 计划给 Lead，等 APPROVE 后再执行。
文件操作规范：写文件一律用 write_file/edit_file 工具（只能在当前工作目录内，这是隔离预期）；
禁止用 run_command 写文件或修改工作目录外的路径（run_command 仅用于构建/测试/查询等非写文件命令）。
中间产物共享：抓取的页面/提取的片段等中间文件写 .mewcode/artifacts/（团队共享区，其他成员可读可写）；最终报告写契约目录（.mewcode/artifacts）。`

// 团队成员可用的基础工具（不含 load_skill——绑定主会话 SkillManager 会污染主会话状态）
const MEMBER_BASE_TOOLS = ['read_file', 'find_files', 'grep_code', 'run_command', 'write_file', 'edit_file', 'team_task', 'team_send']

export class MemberHost {
  history: History
  private member: TeamMember
  private provider: Provider
  private registry: ToolRegistry
  private ctx: ToolContext
  private historyFile: string

  private groupName: string
  private store: TeamGroupStore
  private mail: TeamMail
  private activeAgent: AgentHandle | null = null
  private closeController = new AbortController()
  private closed = false

  private rolePrompt: string // 专家角色 SOP 正文（对齐 Qoder 专家团：角色=领域+专属指令）
  private roleToolsDeny: string[] // 角色禁用的工具（tools_deny frontmatter）
  private roleToolsAllow: string[] // 角色追加的工具（tools_allow frontmatter）
  private roleMaxRounds: number | undefined // 角色 max_rounds（复杂角色 30 轮 vs 默认 15——复杂编排收尾需要）

  constructor(
    member: TeamMember,
    groupName: string,
    opts: {
      provider: Provider
      registry: ToolRegistry
      ctx: ToolContext
      historyFile: string
      store: TeamGroupStore
      mail: TeamMail
      rolePrompt?: string
      roleToolsDeny?: string[]
      roleToolsAllow?: string[]
      roleMaxRounds?: number
    },
  ) {
    this.member = member
    this.groupName = groupName
    this.store = opts.store
    this.mail = opts.mail
    this.provider = opts.provider
    this.registry = opts.registry
    this.ctx = opts.ctx
    this.historyFile = opts.historyFile
    this.rolePrompt = opts.rolePrompt ?? ''
    this.roleToolsDeny = opts.roleToolsDeny ?? []
    this.roleToolsAllow = opts.roleToolsAllow ?? []
    this.roleMaxRounds = opts.roleMaxRounds
    this.history = new History()
    this.resume()
  }

  // 从磁盘恢复上下文
  resume(): void {
    if (!existsSync(this.historyFile)) return
    for (const line of readFileSync(this.historyFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        this.history.push(JSON.parse(line))
      } catch {
        // 坏行跳过
      }
    }
  }

  private persist(): void {
    const msgs = this.history.all()
    if (msgs.length === 0) return
    for (const m of msgs) {
      appendFileSync(this.historyFile, JSON.stringify(m) + '\n', 'utf8')
    }
    // 防止重复：落盘后重建 history（下次 resume 不会重复）
    this.history = new History()
  }

  isBusy(): boolean {
    return this.member.status === 'busy'
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.closeController.abort()
    this.activeAgent?.cancel()
  }

  // 上下文压缩:历史估算超阈值 → 摘要早期对话,保留尾部(对齐主会话 compact)
  private async compactIfNeeded(): Promise<void> {
    const msgs = this.history.all()
    const total = msgs.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
    if (total <= MEMBER_COMPACT_CHARS) return
    const keepTokens = 10000
    const { keep, drop } = tailKeep(msgs, keepTokens)
    if (drop.length === 0) return
    try {
      const summary = await summarize(this.provider, drop, { cwd: this.ctx.cwd, timeoutMs: 60000 })
      const replacement = [summaryMessage(summary), boundaryMessage(), ...keep]
      this.history.replaceRange(0, msgs.length, replacement)
    } catch {
      // 压缩失败不阻塞(继续用全量历史)
    }
  }

  // 审批等待：needsApproval 成员先发 PLAN 给 Lead，轮询邮箱等 APPROVE/DENY（60s 超时）
  private async waitApproval(taskTitle: string): Promise<string | null> {
    const group = this.store.loadGroup(this.groupName)
    const lead = group?.lead ?? 'lead'
    // 只认本 PLAN 发出之后的审批消息——历史 APPROVE 残留会被后续任务误复用
    const planTs = Date.now()
    this.mail.send(this.member.name, lead, `PLAN 任务: ${taskTitle}\n计划: 按任务要求直接执行，等待 Lead 审批`)
    const decision = await this.mail.waitForMessage(
      this.member.name,
      (message) => message.from === lead && message.ts >= planTs && /^(APPROVE|DENY)/.test(message.body),
      Math.max(0, planTs + 60000 - Date.now()),
      this.closeController.signal,
    )
    if (this.closed) return '成员正在关闭，已放弃执行'
    if (decision) {
      if (decision.body.startsWith('DENY')) return `任务被 Lead 拒绝: ${decision.body.slice(6).trim() || '未说明原因'}`
      return null
    }
    return '等待 Lead 审批超时（60s），已放弃执行'
  }

  // 执行任务（协程驻留：runAgent 跑到底）
  // 返回结构化结果：status 供任务状态落库（拒绝/超时 → failed）
  async execute(taskTitle: string): Promise<{ status: 'done' | 'failed'; text: string; report: TeamTaskReport }> {
    if (this.closed) {
      const reportId = createRuntimeId('report')
      return { status: 'failed', text: '成员正在关闭，无法执行新任务', report: { reportId, status: 'failed', summary: '成员正在关闭，无法执行新任务' } }
    }
    this.member.status = 'busy'
    try {
    const startedAt = Date.now()
    // 成员上下文压缩:历史超限时摘要早期对话(大任务多轮后防爆炸)
    await this.compactIfNeeded()
    // subagent_start hook：成员任务开始（与子 agent 同一事件,role 区分）
    void this.ctx.hooks?.fire('subagent_start', {
      cwd: this.ctx.cwd,
      agentId: this.member.name,
      role: `member:${this.member.role}`,
    })
    if (this.member.needsApproval) {
      const denied = await this.waitApproval(taskTitle)
      if (denied !== null) {
        this.member.status = 'idle'
        const reportId = createRuntimeId('report')
        return { status: 'failed', text: denied, report: { reportId, status: 'failed', summary: denied, error: denied } }
      }
    }
    this.history.push({ role: 'user', content: taskTitle })

    // 成员工具集 = 基础工具子集 + 角色追加工具(tools_allow)（按角色 tools_deny 过滤）
    const allowed = new Set([...MEMBER_BASE_TOOLS, ...this.roleToolsAllow])
    const toolsOverride = this.registry
      .toOpenAITools()
      .filter((t) => allowed.has(t.function.name) && !this.roleToolsDeny.includes(t.function.name)) as never

    const agent = runAgent({
      provider: this.provider,
      history: this.history,
      registry: this.registry,
      ctx: { ...this.ctx, hooks: undefined },
      maxIterations: this.roleMaxRounds ?? 15,
      mode: 'full',
      systemPrompt: this.rolePrompt ? `${MEMBER_SYSTEM}\n\n## 你的专家角色\n${this.rolePrompt}` : MEMBER_SYSTEM,
      unknownToolLimit: 2,
      toolsOverride: toolsOverride as never,
    })
    this.activeAgent = agent

    let output = ''
    for await (const ev of agent.events) {
      if (ev.type === 'text') output += ev.text
    }
    const result = await agent.done
    this.persist()
    this.member.status = 'idle'
    // 异常终止(含 tool_repeat/max_iterations 等)都算 failed——中断产物不完整,报 done 会误导 Lead(实战实锤)
    const ABORT_REASONS = new Set(['error', 'tool_failures', 'tool_repeat', 'max_iterations', 'cancelled', 'unknown_tool'])
    const outcome: { status: 'done' | 'failed'; text: string } = ABORT_REASONS.has(result.reason)
      ? { status: 'failed', text: `执行失败（${result.reason}）: ${result.errorMessage ?? '未知原因'}` }
      : { status: 'done', text: output }
    const report: TeamTaskReport = {
      reportId: createRuntimeId('report'),
      status: outcome.status,
      summary: outcome.text.slice(0, 4000),
      tokens: result.totalTokens,
      durationMs: Date.now() - startedAt,
      evidence: collectRuntimeEvidence(
        this.ctx.runtimeEvents?.read(this.ctx.sessionId ?? this.ctx.agentId ?? this.member.name) ?? [],
        this.ctx.agentId ?? this.member.agentId ?? this.member.name,
        startedAt,
      ),
      ...(result.errorMessage ? { error: result.errorMessage } : {}),
    }
    // subagent_stop hook：成员任务结束
    void this.ctx.hooks?.fire('subagent_stop', {
      cwd: this.ctx.cwd,
      agentId: this.member.name,
      role: `member:${this.member.role}`,
      stats: `status=${outcome.status} tokens=${result.totalTokens} duration=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    })
    // teammate_idle hook(对齐 Claude Code):成员空闲——外部可自动派下一个任务
    void this.ctx.hooks?.fire('teammate_idle', {
      cwd: this.ctx.cwd,
      agentId: this.member.name,
      role: `member:${this.member.role}`,
      stats: `status=${outcome.status}`,
    })
    return { ...outcome, report }
    } finally {
      this.activeAgent = null
      this.member.status = 'idle'
    }
  }
}
