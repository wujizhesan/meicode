import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { Provider } from '../provider/types.ts'
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '../tools/index.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import { loadAgentRoles, agentDirs } from '../subagent/loader.ts'
import { TeamGroupStore } from './group.ts'
import { TeamMail } from './mail.ts'
import { MemberHost } from './member.ts'
import type { MailMessage, TeamGroup, TeamMember, TeamTask, TeamTaskReport } from './types.ts'
import { log } from '../log.ts'
import { createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'

const TASK_LEASE_MS = 10 * 60 * 1000

function emitRuntimeEvent(ctx: ToolContext, input: Omit<RuntimeEventInput, 'sessionId'>): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.append({ ...input, sessionId })
  } catch {
  }
}

function git(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
    child.on('error', () => resolve({ code: -1, out }))
  })
}

export class TeamManager {
  private store: TeamGroupStore
  private mail: TeamMail
  private members = new Map<string, MemberHost>()
  private repoRoot: string
  private cfgCoordinator: boolean
  private worktrees: WorktreeManager | null
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private activeRuns = new Set<Promise<unknown>>()
  private closed = false

  private opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext }

  constructor(
    root: string,
    repoRoot: string,
    opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext },
    worktrees?: WorktreeManager | null,
  ) {
    this.opts = opts
    this.store = new TeamGroupStore(root)
    this.mail = new TeamMail(join(root, '_shared', 'mail'))
    this.repoRoot = repoRoot
    this.cfgCoordinator = readCoordinatorConfig(root)
    this.worktrees = worktrees ?? null
  }

  // coordinator：配置开关 + 环境变量双锁
  isCoordinator(): boolean {
    return this.cfgCoordinator && process.env.MEWCOORDINATOR === '1'
  }

  createGroup(name: string, lead: string): TeamGroup {
    return this.store.createGroup(name, lead)
  }

  loadGroup(name: string): TeamGroup | null {
    return this.store.loadGroup(name)
  }

  listGroups(): string[] {
    return this.store.listGroups()
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(timeoutMs = 5000): Promise<void> {
    if (!this.closed) {
      this.closed = true
      for (const timer of this.retryTimers.values()) clearTimeout(timer)
      this.retryTimers.clear()
      for (const member of this.members.values()) member.close()
    }
    if (this.activeRuns.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.activeRuns]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private trackRun<T>(promise: Promise<T>): Promise<T> {
    this.activeRuns.add(promise)
    void promise.then(
      () => this.activeRuns.delete(promise),
      () => this.activeRuns.delete(promise),
    )
    return promise
  }

  // 派生成员（协程驻留）：worktree 隔离 + 加入花名册 + 注册邮箱
  async spawnMember(
    group: TeamGroup,
    name: string,
    role: string,
    opts: { needsApproval?: boolean; workdir?: string } = {},
  ): Promise<MemberHost> {
    // 幂等：同名成员已驻留直接返回（不覆盖 host，避免双写同一 historyFile/worktree）
    const existing = this.members.get(name)
    if (existing) return existing
    // 成员独立 worktree（分支 wt-member-<name>），写文件不污染主仓库
    // 恢复场景(opts.workdir):复用已记录的 workdir,不重新 create
    let workdir = opts.workdir ?? process.cwd()
    if (!opts.workdir && this.worktrees) {
      try {
        const wt = await this.worktrees.create(`member-${name}`)
        workdir = wt.path
      } catch (e) {
        throw new Error(`成员 ${name} worktree 创建失败，已拒绝无隔离启动: ${(e as Error).message}`)
      }
    }
    const member: TeamMember = {
      name,
      agentId: createRuntimeId('agent'),
      role,
      workdir,
      backend: 'coroutine',
      needsApproval: opts.needsApproval ?? false,
      status: 'idle',
    }
    this.store.addMember(group, member)
    this.mail.register(name)
    // 专家角色（对齐 Qoder 专家团）：按 role 名从角色文件加载 SOP 正文与工具限制
    let rolePrompt = ''
    let roleToolsDeny: string[] = []
    let roleToolsAllow: string[] = []
    let roleWritePaths: string[] = []
    let roleMaxRounds: number | undefined
    try {
      const found = loadAgentRoles(agentDirs(process.cwd())).find((r) => r.name === role)
      if (found) {
        rolePrompt = found.content
        roleToolsDeny = found.toolsDeny ?? []
        roleToolsAllow = found.toolsAllow ?? []
        roleWritePaths = found.writePaths ?? []
        roleMaxRounds = found.maxRounds
      }
    } catch {
      // 角色加载失败降级为基础成员
    }
    // 全局共享产物区：成员中间产物互通（实战: 抓的页面他人读不到）
    const sharedArtifacts = join(this.repoRoot, '.mewcode', 'artifacts')
    mkdirSync(sharedArtifacts, { recursive: true })
    const host = new MemberHost(
      member,
      group.name,
      {
        provider: this.opts.provider,
        registry: this.opts.registry,
        // rootLock：成员文件工具只能写 worktree 内（隔离主仓库）；rootLockExtra：契约报告目录 + 共享产物区
        ctx: {
          ...this.opts.ctx,
          agentId: member.agentId,
          cwd: workdir,
          rootLock: workdir,
          rootLockExtra: [...(roleWritePaths.length ? roleWritePaths : []), sharedArtifacts],
        },
        historyFile: join(this.store.groupDir(group.name), 'members', `${name}.history.jsonl`),
        store: this.store,
        mail: this.mail,
        rolePrompt,
        roleToolsDeny,
        roleToolsAllow,
        roleMaxRounds,
      },
    )
    this.members.set(name, host)
    return host
  }

  getMember(name: string): MemberHost | undefined {
    return this.members.get(name)
  }

  // 跨重启恢复:从 group.yaml 重建所有成员(workdir/history 复用,不重新 create worktree)
  async restore(): Promise<string[]> {
    if (this.closed) return []
    const restored: string[] = []
    for (const groupName of this.store.listGroups()) {
      const group = this.store.loadGroup(groupName)
      if (!group) continue
      for (const m of group.members) {
        if (this.members.has(m.name)) continue
        try {
          await this.spawnMember(group, m.name, m.role, {
            needsApproval: m.needsApproval,
            workdir: m.workdir,
          })
          restored.push(`${groupName}/${m.name}`)
        } catch (e) {
          console.warn(`[团队] 恢复成员 ${m.name} 失败: ${(e as Error).message}`)
        }
      }
      this.recoverStaleTasks(groupName)
      this.schedulePendingRetries(groupName)
      this.scheduleReadyTasks(groupName)
    }
    return restored
  }

  // Lead 读邮箱（成员发来的 IDLE/PLAN/汇报；markRead=true 时标记已读）
  readLeadMail(markRead = false): MailMessage[] {
    return this.mail.read('lead', markRead)
  }

  // Lead 审批响应：向成员发 APPROVE/DENY（成员 needsApproval 时执行前等待此消息）
  respondApproval(groupName: string, memberName: string, approve: boolean, note?: string): string {
    const group = this.store.loadGroup(groupName)
    if (!group) return `小组不存在: ${groupName}`
    if (!this.members.has(memberName)) return `成员不存在: ${memberName}`
    const body = `${approve ? 'APPROVE' : 'DENY'} ${note ?? ''}`.trim()
    this.mail.send(group.lead, memberName, body)
    return `已${approve ? '批准' : '拒绝'} ${memberName} 的审批请求${note ? `（${note}）` : ''}`
  }

  // 按工作目录反查成员身份（成员协作工具用，支持多组多成员全局注册）
  resolveMemberByCwd(cwd: string): { group: TeamGroup; member: TeamMember } | null {
    const target = resolve(cwd).toLowerCase()
    for (const groupName of this.store.listGroups()) {
      const g = this.store.loadGroup(groupName)
      if (!g) continue
      for (const m of g.members) {
        if (resolve(m.workdir).toLowerCase() === target) return { group: g, member: m }
      }
    }
    return null
  }

  // 成员协作工具（全局注册一份）：执行时按 ctx.cwd 解析成员身份
  memberTools(): Tool[] {
    return [
      {
        name: 'team_task',
        description:
          '团队共享任务操作。action=list 查看任务清单；create 创建（title/assignee）；update 更新状态（id/status: todo|in_progress|done|failed）；result 记录结果。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'list / create / update' },
            id: { type: 'string', description: '任务 id（update 用）' },
            title: { type: 'string', description: '任务标题（create 用）' },
            assignee: { type: 'string', description: '负责人（create 用）' },
            depends_on: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表（create 用）' },
            max_attempts: { type: 'number', description: '最多执行次数（create 用）' },
            status: { type: 'string', description: '任务状态' },
            result: { type: 'string', description: '任务结果摘要（update 用）' },
          },
          required: ['action'],
        },
        execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
          const hit = this.resolveMemberByCwd(ctx.cwd)
          if (!hit) return { success: false, output: '', error: '无法识别成员身份（ctx.cwd 不在任何成员 workdir）' }
          const groupName = hit.group.name
          const memberName = hit.member.name
          const action = String(args.action ?? '')
          if (action === 'list') {
            const tasks = this.store.listTasks(groupName)
            return { success: true, output: tasks.length ? JSON.stringify(tasks, null, 2) : '（无任务）' }
          }
          if (action === 'create') {
            const dependsOn = Array.isArray(args.depends_on) ? args.depends_on.filter((v): v is string => typeof v === 'string') : []
            const maxAttempts = typeof args.max_attempts === 'number' && args.max_attempts > 0 ? Math.floor(args.max_attempts) : 1
            let task: TeamTask
            try {
              task = this.addTask(groupName, String(args.title ?? '未命名'), typeof args.assignee === 'string' ? args.assignee : memberName, dependsOn, maxAttempts)
            } catch (e) {
              return { success: false, output: '', error: (e as Error).message }
            }
            return { success: true, output: `已创建任务 ${task.id}: ${task.title}` }
          }
          if (action === 'update') {
            const id = String(args.id ?? '')
            const patch: Record<string, unknown> = {}
            if (typeof args.status === 'string') patch.status = args.status
            if (typeof args.result === 'string') patch.result = args.result
            const updated = this.store.updateTask(groupName, id, patch)
            if (!updated) return { success: false, output: '', error: `任务不存在: ${id}` }
            return { success: true, output: `任务 ${id} 已更新: ${updated.status}` }
          }
          return { success: false, output: '', error: `未知 action: ${action}` }
        },
      },
      {
        name: 'team_send',
        description:
          '团队消息。to=成员名或 *（广播）或 Lead。协议消息首行：PLAN（计划待审批）、APPROVE/DENY（审批回复）、IDLE（任务完成通知）。',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: '收件人（成员名 / Lead / * 广播）' },
            body: { type: 'string', description: '消息正文（可含协议首行）' },
          },
          required: ['to', 'body'],
        },
        execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
          const hit = this.resolveMemberByCwd(ctx.cwd)
          // 身份:成员用自己,Lead(主会话,不在任何 workdir)用 lead——Lead 要能发消息给成员
          const from = hit ? hit.member.name : 'lead'
          const to = String(args.to ?? '')
          const body = String(args.body ?? '')
          if (!to || !body) return { success: false, output: '', error: '缺少 to/body' }
          this.mail.send(from, to, body)
          return { success: true, output: `已发送消息给 ${to}` }
        },
      },
    ]
  }

  // Lead 指派：更新任务状态 + 触发成员执行（异步协程）
  async assignTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    if (this.closed) return 'TeamManager 已关闭，无法分派任务'
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    const current = this.store.listTasks(group.name).find((item) => item.id === task.id)
    if (!current) return `任务不存在: ${task.id}`
    const blockers = this.taskBlockers(group.name, current)
    if (blockers.length > 0) return `任务 ${task.id} 仍被依赖阻塞: ${blockers.join(', ')}`
    // busy 检查：并发指派同一成员会让两个 runAgent 交错写同一 History
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    const attempt = (current.attempt ?? 0) + 1
    if (attempt > (current.maxAttempts ?? 1)) return `任务 ${task.id} 已达到最大执行次数`
    const member = group.members.find((item) => item.name === memberName)
    const leaseId = createRuntimeId('lease')
    const claimed = this.store.claimTask(group.name, task.id, { status: 'in_progress', assignee: memberName, attempt, activeAgentId: member?.agentId, leaseId, leaseExpiresAt: Date.now() + TASK_LEASE_MS, nextRetryAt: undefined, updatedAt: Date.now() })
    if (!claimed) return `任务 ${task.id} 已被其他执行者领取`
    emitRuntimeEvent(this.opts.ctx, { type: 'task_assigned', taskId: task.id, agentId: member?.agentId, payload: { groupId: group.name, memberName, attempt } })
    // needsApproval 成员：execute 内部发 PLAN 等 Lead 审批后再执行（审批在成员层等待）
    const execution = host
      .execute(task.title)
      .then((result) => {
        this.completeTask(group, task, memberName, member?.agentId, result)
      })
      .catch((e) => {
        const error = (e as Error).message
        const reportId = createRuntimeId('report')
        this.completeTask(group, task, memberName, member?.agentId, { status: 'failed', text: `执行异常: ${error}`, report: { reportId, status: 'failed', summary: `执行异常: ${error}`, error } })
      })
    this.trackRun(execution)
    const groupMember = group.members.find((m) => m.name === memberName)
    return groupMember?.needsApproval
      ? `已派发任务 ${task.id} 给 ${memberName}（需审批，成员已发 PLAN 等待 Lead 决定）`
      : `已指派成员 ${memberName} 执行任务 ${task.id}`
  }

  // Lead 工具用：同步等待成员执行完成，返回执行结果（供 team_assign 工具回灌）
  // 120s 超时转后台——成员最长 15 轮×60s，不设限会挂死主对话；
  // 超时后成员完成仍会写 done（完成逻辑在 execPromise 内）
  async runTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    if (this.closed) return 'TeamManager 已关闭，无法执行任务'
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    const current = this.store.listTasks(group.name).find((item) => item.id === task.id)
    if (!current) return `任务不存在: ${task.id}`
    const blockers = this.taskBlockers(group.name, current)
    if (blockers.length > 0) return `任务 ${task.id} 仍被依赖阻塞: ${blockers.join(', ')}`
    const attempt = (current.attempt ?? 0) + 1
    if (attempt > (current.maxAttempts ?? 1)) return `任务 ${task.id} 已达到最大执行次数`
    const member = group.members.find((item) => item.name === memberName)
    const leaseId = createRuntimeId('lease')
    const claimed = this.store.claimTask(group.name, task.id, { status: 'in_progress', assignee: memberName, attempt, activeAgentId: member?.agentId, leaseId, leaseExpiresAt: Date.now() + TASK_LEASE_MS, nextRetryAt: undefined, updatedAt: Date.now() })
    if (!claimed) return `任务 ${task.id} 已被其他执行者领取`
    emitRuntimeEvent(this.opts.ctx, { type: 'task_assigned', taskId: task.id, agentId: member?.agentId, payload: { groupId: group.name, memberName, attempt } })
    const execPromise = this.trackRun(host
      .execute(task.title)
      .then((result) => {
        this.completeTask(group, task, memberName, member?.agentId, result)
        // task_completed hook:外部感知任务完成(主会话自动汇报/流水线下一步)
        void this.opts.ctx.hooks?.fire('task_completed', {
          cwd: this.opts.ctx.cwd,
          stats: `task=${task.id} "${task.title.slice(0, 40)}" member=${memberName} status=${result.status}`,
        })
        return result.text
      })
      .catch((e) => {
        const error = (e as Error).message
        const reportId = createRuntimeId('report')
        this.completeTask(group, task, memberName, member?.agentId, { status: 'failed', text: `执行异常: ${error}`, report: { reportId, status: 'failed', summary: `执行异常: ${error}`, error } })
        return `任务执行异常: ${error}`
      })
    )
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve('__TIMEOUT__'), 120000)
    })
    const settled = await Promise.race([execPromise, timeoutPromise])
    if (timeout) clearTimeout(timeout)
    return settled === '__TIMEOUT__'
      ? `任务 ${task.id} 仍在执行中（成员 ${memberName}），稍后用 team_tasks 或 team_mail 查看结果`
      : settled
  }

  listTasks(groupName: string): TeamTask[] {
    return this.store.listTasks(groupName)
  }

  private dependencyError(tasks: TeamTask[], taskId: string, dependsOn: string[]): string | null {
    const graph = new Map(tasks.map((task) => [task.id, task.depends_on ?? []]))
    graph.set(taskId, dependsOn)
    for (const dependency of dependsOn) {
      if (!graph.has(dependency)) return `依赖任务不存在: ${dependency}`
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): string | null => {
      if (visiting.has(id)) return `任务依赖形成循环: ${id}`
      if (visited.has(id)) return null
      visiting.add(id)
      for (const dependency of graph.get(id) ?? []) {
        const error = visit(dependency)
        if (error) return error
      }
      visiting.delete(id)
      visited.add(id)
      return null
    }
    for (const id of graph.keys()) {
      const error = visit(id)
      if (error) return error
    }
    return null
  }

  taskBlockers(groupName: string, task: TeamTask): string[] {
    const tasks = this.store.listTasks(groupName)
    const byId = new Map(tasks.map((item) => [item.id, item]))
    return (task.depends_on ?? []).filter((dependency) => byId.get(dependency)?.status !== 'done')
  }

  recoverStaleTasks(groupName: string, now = Date.now()): TeamTask[] {
    const recovered: TeamTask[] = []
    this.store.mutateTasks(groupName, (tasks) => {
      for (const task of tasks) {
        if (task.status !== 'in_progress' || !task.leaseExpiresAt || task.leaseExpiresAt > now) continue
        const retryable = (task.attempt ?? 0) < (task.maxAttempts ?? 1)
        task.status = retryable ? 'todo' : 'failed'
        task.updatedAt = now
      task.lastError = '任务租约过期，执行进程可能已退出'
        task.nextRetryAt = retryable ? now : undefined
        task.activeAgentId = undefined
        task.leaseId = undefined
        task.leaseExpiresAt = undefined
        recovered.push({ ...task })
      }
    })
    return recovered
  }

  private scheduleRetry(group: TeamGroup, task: TeamTask, memberName: string, delayMs: number): void {
    const key = `${group.name}:${task.id}`
    const existing = this.retryTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      if (this.closed) return
      const latest = this.store.listTasks(group.name).find((item) => item.id === task.id)
      if (!latest || latest.status !== 'todo' || (latest.nextRetryAt ?? 0) > Date.now()) return
      void this.runTask(group, latest, memberName)
    }, Math.max(0, delayMs))
    this.retryTimers.set(key, timer)
  }

  private schedulePendingRetries(groupName: string): void {
    const group = this.store.loadGroup(groupName)
    if (!group) return
    const now = Date.now()
    for (const task of this.store.listTasks(groupName)) {
      if (task.status !== 'todo' || !task.assignee || !task.nextRetryAt || task.nextRetryAt <= now) continue
      if (!this.members.has(task.assignee)) continue
      this.scheduleRetry(group, task, task.assignee, task.nextRetryAt - now)
    }
  }

  private completeTask(group: TeamGroup, task: TeamTask, memberName: string, agentId: string | undefined, result: { status: 'done' | 'failed'; text: string; report: TeamTaskReport }): void {
    const current = this.store.listTasks(group.name).find((item) => item.id === task.id)
    if (!current) return
    const retryable = result.status === 'failed' && (current.attempt ?? 0) < (current.maxAttempts ?? 1)
    const nextRetryAt = retryable ? Date.now() + Math.min(30000, 1000 * 2 ** Math.max(0, (current.attempt ?? 1) - 1)) : undefined
    this.store.updateTask(group.name, task.id, {
      status: retryable ? 'todo' : result.status,
      result: result.text.slice(0, 4000),
      reportId: result.report.reportId,
      report: result.report,
      lastError: result.status === 'failed' ? result.report.error ?? result.text.slice(0, 500) : undefined,
      nextRetryAt,
      activeAgentId: undefined,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    })
    const protocol = retryable ? 'RETRY' : result.status === 'done' ? 'IDLE' : 'ERR'
    this.mail.send(memberName, group.lead, `${protocol} 任务 ${task.id}: ${result.text.split('\n')[0].slice(0, 200)}`, {
      groupId: group.name,
      kind: retryable ? 'task_retry' : 'task_result',
      taskId: task.id,
      correlationId: result.report.reportId,
    })
    emitRuntimeEvent(this.opts.ctx, { type: 'task_finished', taskId: task.id, agentId, payload: { groupId: group.name, status: result.status, retryable, reportId: result.report.reportId, nextRetryAt } })
    if (retryable && nextRetryAt) this.scheduleRetry(group, { ...task, nextRetryAt }, memberName, Math.max(0, nextRetryAt - Date.now()))
    if (result.status === 'done') this.scheduleReadyTasks(group.name)
  }

  listReadyTasks(groupName: string): TeamTask[] {
    const now = Date.now()
    return this.store.listTasks(groupName).filter((task) => task.status === 'todo' && (task.nextRetryAt ?? 0) <= now && this.taskBlockers(groupName, task).length === 0)
  }

  scheduleReadyTasks(groupName: string): string[] {
    if (this.closed) return []
    const group = this.store.loadGroup(groupName)
    if (!group) return []
    const scheduled: string[] = []
    for (const task of this.listReadyTasks(groupName)) {
      if (!task.assignee || (task.attempt ?? 0) >= (task.maxAttempts ?? 1)) continue
      const host = this.members.get(task.assignee)
      if (!host || host.isBusy()) continue
      void this.assignTask(group, task, task.assignee)
      scheduled.push(task.id)
    }
    return scheduled
  }

  addTask(groupName: string, title: string, assignee?: string, dependsOn: string[] = [], maxAttempts = 1): TeamTask {
    const normalizedDeps = [...new Set(dependsOn)]
    const id = createRuntimeId('task')
    const now = Date.now()
    const task: TeamTask = {
      id,
      title,
      status: 'todo',
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      maxAttempts: Math.max(1, Math.floor(maxAttempts)),
      ...(normalizedDeps.length ? { depends_on: normalizedDeps } : {}),
      ...(assignee ? { assignee } : {}),
    }
    let dependencyError: string | null = null
    this.store.mutateTasks(groupName, (tasks) => {
      dependencyError = this.dependencyError(tasks, id, normalizedDeps)
      if (!dependencyError) tasks.push(task)
    })
    if (dependencyError) throw new Error(dependencyError)
    emitRuntimeEvent(this.opts.ctx, {
      type: 'task_created',
      taskId: task.id,
      payload: { groupId: groupName, title, assignee, dependsOn: normalizedDeps },
    })
    // task_created hook:外部感知任务创建(主会话可自动跟踪/汇报)
    void this.opts.ctx.hooks?.fire('task_created', {
      cwd: this.opts.ctx.cwd,
      stats: `task=${task.id} "${title.slice(0, 60)}"${assignee ? ` assignee=${assignee}` : ''}`,
    })
    return task
  }

  // 成员空闲标记（成员自己完成后调用）
  markMemberIdle(group: TeamGroup, name: string): void {
    const member = group.members.find((m) => m.name === name)
    if (member) member.status = 'idle'
    this.store.saveGroup(group)
  }

  // 全部完成后合并各成员 worktree：成员改动先 commit，再合并回主仓库
  async mergeAll(group: TeamGroup): Promise<string> {
    const results: string[] = []
    for (const member of group.members) {
      if (!this.worktrees) {
        results.push(`成员 ${member.name} 无 worktree 支持，跳过`)
        continue
      }
      const wtName = `member-${member.name}`
      try {
        const info = await this.worktrees.exit(wtName)
        if (!info.dirty) {
          results.push(`成员 ${member.name} 无变更，跳过`)
          continue
        }
        // 先提交成员 worktree 内的改动（merge 只能合 commit）
        const add = await git(['-C', info.path, 'add', '-A'])
        const commit = await git(['-C', info.path, 'commit', '-m', `team: ${member.name} changes`])
        if (add.code !== 0 || commit.code !== 0) {
          results.push(`✗ 成员 ${member.name} commit 失败: ${add.out || commit.out}`.slice(0, 150))
          continue
        }
        const res = await git(['merge', `wt-${wtName}`], this.repoRoot)
        if (res.code === 0) {
          results.push(`✓ 合并 ${member.name} 成功`)
        } else {
          // 冲突：先取冲突文件列表（abort 后 diff 看不到），再回滚（worktree 保留待人工处理）
          const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], this.repoRoot)
          await git(['merge', '--abort'], this.repoRoot)
          const files = conflicts.out.trim()
          results.push(
            `✗ 合并 ${member.name} 冲突，已回滚（worktree ${wtName} 保留待处理）\n  冲突文件: ${files || '(未检测到)'}`,
          )
        }
      } catch (e) {
        results.push(`✗ 成员 ${member.name} 合并失败: ${(e as Error).message}`)
      }
    }
    return results.join('\n')
  }

  // coordinator 开启时 Lead 工具集：移除 write/edit（保留读 + run_command + spawn）
  createLeadTools(): ReturnType<ToolRegistry['toOpenAITools']> | null {
    if (!this.isCoordinator()) return null
    return this.opts.registry
      .toOpenAITools()
      .filter((t) => t.function.name !== 'write_file' && t.function.name !== 'edit_file')
  }
}

function readCoordinatorConfig(root: string): boolean {
  const file = join(root, 'team.yaml')
  if (!existsSync(file)) return false
  try {
    const cfg = parse(readFileSync(file, 'utf8')) as { coordinator_enabled?: boolean }
    return cfg.coordinator_enabled === true
  } catch {
    return false
  }
}

export { TeamGroupStore } from './group.ts'
export { TeamMail } from './mail.ts'
export { MemberHost } from './member.ts'
export type { TeamGroup, TeamMember, TeamTask, TeamTaskReport, MailMessage } from './types.ts'
