import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Provider } from '../provider/types.ts'
import type { Tool, ToolContext, ToolRegistry } from '../tools/index.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import { loadAgentRoles, agentDirs } from '../subagent/loader.ts'
import type { AgentRole } from '../subagent/types.ts'
import { TeamGroupStore } from './group.ts'
import { TeamMail } from './mail.ts'
import { MemberHost } from './member.ts'
import type { MailMessage, TeamGroup, TeamMember, TeamTask, TeamTaskReport } from './types.ts'
import { log } from '../log.ts'
import { createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'
import { readCoordinatorConfig } from './config.ts'
import { createMemberTools } from './member-tools.ts'
import { mergeTeamWorktrees } from './merge.ts'
import { readyTasks, recoverExpiredTasks, taskBlockers, validateTaskDependencies } from './task-graph.ts'

const TASK_LEASE_MS = 10 * 60 * 1000

interface TaskExecutionClaim {
  host: MemberHost
  member?: TeamMember
}

function sameTeamMember(left: TeamMember, right: TeamMember): boolean {
  return left.name === right.name
    && left.agentId === right.agentId
    && left.role === right.role
    && left.workdir === right.workdir
    && left.backend === right.backend
    && left.needsApproval === right.needsApproval
    && left.status === right.status
    && left.updatedAt === right.updatedAt
}

function emitRuntimeEvent(ctx: ToolContext, input: Omit<RuntimeEventInput, 'sessionId'>): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.append({ ...input, sessionId })
  } catch {
  }
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
    opts: {
      needsApproval?: boolean
      workdir?: string
      deferGroupSave?: boolean
      roleDefinition?: AgentRole | null
      agentId?: string
      updatedAt?: number
    } = {},
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
      agentId: opts.agentId ?? createRuntimeId('agent'),
      role,
      workdir,
      backend: 'coroutine',
      needsApproval: opts.needsApproval ?? false,
      status: 'idle',
      ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {}),
    }
    if (opts.deferGroupSave) {
      group.members = group.members.filter((current) => current.name !== member.name)
      group.members.push(member)
    } else {
      this.store.addMember(group, member)
    }
    this.mail.register(name)
    // 专家角色（对齐 Qoder 专家团）：按 role 名从角色文件加载 SOP 正文与工具限制
    let rolePrompt = ''
    let roleToolsDeny: string[] = []
    let roleToolsAllow: string[] = []
    let roleWritePaths: string[] = []
    let roleMaxRounds: number | undefined
    try {
      const found = 'roleDefinition' in opts
        ? opts.roleDefinition
        : loadAgentRoles(agentDirs(process.cwd())).find((r) => r.name === role)
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
  async restore(roleDefinitions?: readonly AgentRole[]): Promise<string[]> {
    if (this.closed) return []
    const restored: string[] = []
    let restoreRoles = roleDefinitions
      ? new Map(roleDefinitions.map((role) => [role.name, role]))
      : undefined
    const findRestoreRole = (name: string): AgentRole | null => {
      if (!restoreRoles) {
        try {
          restoreRoles = new Map(loadAgentRoles(agentDirs(process.cwd())).map((role) => [role.name, role]))
        } catch {
          restoreRoles = new Map()
        }
      }
      return restoreRoles.get(name) ?? null
    }
    for (const groupName of this.store.listGroups()) {
      const group = this.store.loadGroup(groupName)
      if (!group) continue
      const persistedMembers = [...group.members]
      const refreshedMembers: TeamMember[] = []
      for (const m of persistedMembers) {
        if (this.members.has(m.name)) continue
        try {
          await this.spawnMember(group, m.name, m.role, {
            needsApproval: m.needsApproval,
            workdir: m.workdir,
            deferGroupSave: true,
            roleDefinition: findRestoreRole(m.role),
            agentId: m.agentId,
            updatedAt: m.updatedAt,
          })
          const refreshed = group.members.find((member) => member.name === m.name)
          if (refreshed) refreshedMembers.push(refreshed)
          restored.push(`${groupName}/${m.name}`)
        } catch (e) {
          console.warn(`[团队] 恢复成员 ${m.name} 失败: ${(e as Error).message}`)
        }
      }
      const membersChanged = persistedMembers.length !== group.members.length
        || persistedMembers.some((member, index) => !sameTeamMember(member, group.members[index]))
      if (membersChanged) this.store.addMembers(group, refreshedMembers)
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
    return createMemberTools({
      resolveMemberByCwd: (cwd) => this.resolveMemberByCwd(cwd),
      listTasks: (groupName) => this.store.listTasks(groupName),
      addTask: (groupName, title, assignee, dependencies, maxAttempts) =>
        this.addTask(groupName, title, assignee, dependencies, maxAttempts),
      updateTask: (groupName, taskId, patch) => this.store.updateTask(groupName, taskId, patch),
      sendMail: (from, to, body) => this.mail.send(from, to, body),
    })
  }

  // Lead 指派：更新任务状态 + 触发成员执行（异步协程）
  async assignTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    if (this.closed) return 'TeamManager 已关闭，无法分派任务'
    const claim = this.claimTask(group, task, memberName)
    if (typeof claim === 'string') return claim
    void this.executeClaimedTask(group, task, memberName, claim, false)
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
    const claim = this.claimTask(group, task, memberName)
    if (typeof claim === 'string') return claim
    const execPromise = this.executeClaimedTask(group, task, memberName, claim, true)
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

  private claimTask(group: TeamGroup, task: TeamTask, memberName: string): TaskExecutionClaim | string {
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    const current = this.store.listTasks(group.name).find((item) => item.id === task.id)
    if (!current) return `任务不存在: ${task.id}`
    const blockers = this.taskBlockers(group.name, current)
    if (blockers.length > 0) return `任务 ${task.id} 仍被依赖阻塞: ${blockers.join(', ')}`
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    const attempt = (current.attempt ?? 0) + 1
    if (attempt > (current.maxAttempts ?? 1)) return `任务 ${task.id} 已达到最大执行次数`
    const member = group.members.find((item) => item.name === memberName)
    const claimed = this.store.claimTask(group.name, task.id, {
      status: 'in_progress',
      assignee: memberName,
      attempt,
      activeAgentId: member?.agentId,
      leaseId: createRuntimeId('lease'),
      leaseExpiresAt: Date.now() + TASK_LEASE_MS,
      nextRetryAt: undefined,
      updatedAt: Date.now(),
    })
    if (!claimed) return `任务 ${task.id} 已被其他执行者领取`
    emitRuntimeEvent(this.opts.ctx, {
      type: 'task_assigned',
      taskId: task.id,
      agentId: member?.agentId,
      payload: { groupId: group.name, memberName, attempt },
    })
    return { host, member }
  }

  private executeClaimedTask(
    group: TeamGroup,
    task: TeamTask,
    memberName: string,
    claim: TaskExecutionClaim,
    fireCompletionHook: boolean,
  ): Promise<string> {
    const execution = claim.host.execute(task.title).then((result) => {
      this.completeTask(group, task, memberName, claim.member?.agentId, result)
      if (fireCompletionHook) {
        void this.opts.ctx.hooks?.fire('task_completed', {
          cwd: this.opts.ctx.cwd,
          stats: `task=${task.id} "${task.title.slice(0, 40)}" member=${memberName} status=${result.status}`,
        })
      }
      return result.text
    }).catch((error: unknown) => {
      const message = (error as Error).message
      const reportId = createRuntimeId('report')
      this.completeTask(group, task, memberName, claim.member?.agentId, {
        status: 'failed',
        text: `执行异常: ${message}`,
        report: { reportId, status: 'failed', summary: `执行异常: ${message}`, error: message },
      })
      return `任务执行异常: ${message}`
    })
    return this.trackRun(execution)
  }

  listTasks(groupName: string): TeamTask[] {
    return this.store.listTasks(groupName)
  }

  taskBlockers(groupName: string, task: TeamTask): string[] {
    return taskBlockers(this.store.listTasks(groupName), task)
  }

  recoverStaleTasks(groupName: string, now = Date.now()): TeamTask[] {
    const snapshot = this.store.listTasks(groupName)
    if (!snapshot.some((task) => task.status === 'in_progress' && task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= now)) return []
    let recovered: TeamTask[] = []
    this.store.mutateTasks(groupName, (tasks) => {
      recovered = recoverExpiredTasks(tasks, now)
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
    return readyTasks(this.store.listTasks(groupName))
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
      dependencyError = validateTaskDependencies(tasks, id, normalizedDeps)
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
    return mergeTeamWorktrees(group, this.worktrees, this.repoRoot)
  }

  // coordinator 开启时 Lead 工具集：移除 write/edit（保留读 + run_command + spawn）
  createLeadTools(): ReturnType<ToolRegistry['toOpenAITools']> | null {
    if (!this.isCoordinator()) return null
    return this.opts.registry
      .toOpenAITools()
      .filter((t) => t.function.name !== 'write_file' && t.function.name !== 'edit_file')
  }
}

export { TeamGroupStore } from './group.ts'
export { TeamMail } from './mail.ts'
export { MemberHost } from './member.ts'
export type { TeamGroup, TeamMember, TeamTask, TeamTaskReport, MailMessage } from './types.ts'
