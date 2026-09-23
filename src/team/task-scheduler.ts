import type { ToolContext } from '../tools/index.ts'
import { createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'
import type { TeamGroupStore } from './group.ts'
import type { TeamMail } from './mail.ts'
import type { MemberHost } from './member.ts'
import type { TeamGroup, TeamMember, TeamTask, TeamTaskReport } from './types.ts'
import { readyTasks, recoverExpiredTasks, taskBlockers, validateTaskDependencies } from './task-graph.ts'

const TASK_LEASE_MS = 10 * 60 * 1000
const TASK_TITLE_MAX_CHARS = 4000
const TASK_MAX_ATTEMPTS = 100
const TASK_EXECUTION_TIMEOUT = Symbol('team_task_execution_timeout')

interface TaskExecutionClaim {
  host: MemberHost
  member: TeamMember
  leaseId: string
  ctx: ToolContext
}

interface ActiveTaskClaim {
  groupName: string
  taskId: string
  leaseId: string
  ctx: ToolContext
}

interface TeamTaskSchedulerOptions {
  store: TeamGroupStore
  mail: TeamMail
  members: ReadonlyMap<string, MemberHost>
  memberGroups: ReadonlyMap<string, string>
  ctx: ToolContext
  leaseMs?: number
  leaseHeartbeatMs?: number
}

function emitRuntimeEvent(ctx: ToolContext, input: Omit<RuntimeEventInput, 'sessionId'>): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.append({ ...input, sessionId })
  } catch {
  }
}

export class TeamTaskScheduler {
  private readonly store: TeamGroupStore
  private readonly mail: TeamMail
  private readonly members: ReadonlyMap<string, MemberHost>
  private readonly memberGroups: ReadonlyMap<string, string>
  private readonly ctx: ToolContext
  private readonly leaseMs: number
  private readonly leaseHeartbeatMs: number
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly leaseHeartbeats = new Set<ReturnType<typeof setInterval>>()
  private readonly activeRuns = new Set<Promise<unknown>>()
  private readonly activeClaims = new Map<string, ActiveTaskClaim>()
  private readonly managedGroups = new Set<string>()
  private readonly staleRecoveryTimer: ReturnType<typeof setInterval>
  private closed = false

  constructor(options: TeamTaskSchedulerOptions) {
    this.store = options.store
    this.mail = options.mail
    this.members = options.members
    this.memberGroups = options.memberGroups
    this.ctx = options.ctx
    this.leaseMs = Math.max(10, Math.floor(options.leaseMs ?? TASK_LEASE_MS))
    this.leaseHeartbeatMs = Math.max(5, Math.min(this.leaseMs - 1, Math.floor(options.leaseHeartbeatMs ?? this.leaseMs / 3)))
    this.staleRecoveryTimer = setInterval(() => this.reconcileManagedGroups(), Math.max(25, Math.min(60000, Math.floor(this.leaseMs / 3))))
    this.staleRecoveryTimer.unref()
  }

  isClosed(): boolean {
    return this.closed
  }

  setSessionId(sessionId: string): void {
    this.ctx.sessionId = sessionId
  }

  async close(timeoutMs = 5000): Promise<void> {
    if (!this.closed) {
      this.closed = true
      for (const timer of this.retryTimers.values()) clearTimeout(timer)
      this.retryTimers.clear()
      clearInterval(this.staleRecoveryTimer)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.activeRuns.size > 0) {
        await Promise.race([
          Promise.allSettled([...this.activeRuns]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, timeoutMs))
          }),
        ])
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.releaseActiveClaims()
      for (const heartbeat of this.leaseHeartbeats) clearInterval(heartbeat)
      this.leaseHeartbeats.clear()
    }
  }

  private reconcileManagedGroups(): void {
    if (this.closed) return
    for (const groupName of this.managedGroups) {
      try {
        this.recoverStaleTasks(groupName, Date.now(), true)
        this.schedulePendingRetries(groupName)
        this.scheduleReadyTasks(groupName)
      } catch (error) {
        emitRuntimeEvent(this.ctx, {
          type: 'audit',
          payload: { kind: 'team_stale_recovery_failed', groupId: groupName, error: (error as Error).message },
        })
      }
    }
  }

  private releaseActiveClaims(): void {
    const now = Date.now()
    for (const claim of this.activeClaims.values()) {
      try {
        this.store.mutateTasks(claim.groupName, (tasks) => {
          const task = tasks.find((item) => item.id === claim.taskId)
          if (!task || task.status !== 'in_progress' || task.leaseId !== claim.leaseId) return
          task.status = 'todo'
          task.attempt = Math.max(0, (task.attempt ?? 1) - 1)
          task.lastError = '调度器关闭，任务已重新排队'
          task.nextRetryAt = now
          task.activeAgentId = undefined
          task.leaseId = undefined
          task.leaseExpiresAt = undefined
          task.updatedAt = now
        })
      } catch (error) {
        emitRuntimeEvent(claim.ctx, {
          type: 'audit',
          taskId: claim.taskId,
          payload: { kind: 'team_shutdown_release_failed', groupId: claim.groupName, leaseId: claim.leaseId, error: (error as Error).message },
        })
      }
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

  private startLeaseHeartbeat(groupName: string, taskId: string, leaseId: string, ctx: ToolContext): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      let renewed = false
      try {
        this.store.mutateTasks(groupName, (tasks) => {
          const task = tasks.find((item) => item.id === taskId)
          if (!task || task.status !== 'in_progress' || task.leaseId !== leaseId) return
          task.leaseExpiresAt = Date.now() + this.leaseMs
          renewed = true
        })
      } catch (error) {
        emitRuntimeEvent(ctx, {
          type: 'audit',
          taskId,
          payload: { kind: 'team_lease_heartbeat_failed', groupId: groupName, leaseId, error: (error as Error).message },
        })
        console.warn(`[团队] 任务 ${taskId} 租约续期失败: ${(error as Error).message}`)
        return
      }
      if (!renewed) {
        clearInterval(timer)
        this.leaseHeartbeats.delete(timer)
      }
    }, this.leaseHeartbeatMs)
    timer.unref()
    this.leaseHeartbeats.add(timer)
    return timer
  }

  private stopLeaseHeartbeat(timer: ReturnType<typeof setInterval>): void {
    clearInterval(timer)
    this.leaseHeartbeats.delete(timer)
  }

  async assignTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    if (this.closed) return 'TeamManager 已关闭，无法分派任务'
    const claim = this.claimTask(group, task, memberName)
    if (typeof claim === 'string') return claim
    void this.executeClaimedTask(group, task, memberName, claim, false)
    const groupMember = group.members.find((member) => member.name === memberName)
    return groupMember?.needsApproval
      ? `已派发任务 ${task.id} 给 ${memberName}（需审批，成员已发 PLAN 等待 Lead 决定）`
      : `已指派成员 ${memberName} 执行任务 ${task.id}`
  }

  async runTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    if (this.closed) return 'TeamManager 已关闭，无法执行任务'
    const claim = this.claimTask(group, task, memberName)
    if (typeof claim === 'string') return claim
    const execution = this.executeClaimedTask(group, task, memberName, claim, true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TASK_EXECUTION_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TASK_EXECUTION_TIMEOUT), 120000)
    })
    let settled: string | typeof TASK_EXECUTION_TIMEOUT
    try {
      settled = await Promise.race([execution, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return settled === TASK_EXECUTION_TIMEOUT
      ? `任务 ${task.id} 仍在执行中（成员 ${memberName}），稍后用 team_tasks 或 team_mail 查看结果`
      : settled
  }

  private claimTask(group: TeamGroup, task: TeamTask, memberName: string): TaskExecutionClaim | string {
    this.managedGroups.add(group.name)
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    const member = group.members.find((item) => item.name === memberName)
    if (!member || this.memberGroups.get(memberName) !== group.name) return `成员 ${memberName} 不属于小组 ${group.name}`
    const current = this.store.listTasks(group.name).find((item) => item.id === task.id)
    if (!current) return `任务不存在: ${task.id}`
    const blockers = this.taskBlockers(group.name, current)
    if (blockers.length > 0) return `任务 ${task.id} 仍被依赖阻塞: ${blockers.join(', ')}`
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    const attempt = (current.attempt ?? 0) + 1
    if (attempt > (current.maxAttempts ?? 1)) return `任务 ${task.id} 已达到最大执行次数`
    const leaseId = createRuntimeId('lease')
    const claimed = this.store.claimTask(group.name, task.id, {
      status: 'in_progress',
      assignee: memberName,
      attempt,
      activeAgentId: member.agentId,
      leaseId,
      leaseExpiresAt: Date.now() + this.leaseMs,
      nextRetryAt: undefined,
      updatedAt: Date.now(),
    })
    if (!claimed) return `任务 ${task.id} 已被其他执行者领取`
    const executionCtx: ToolContext = { ...this.ctx }
    emitRuntimeEvent(executionCtx, {
      type: 'task_assigned',
      taskId: task.id,
      agentId: member.agentId,
      payload: { groupId: group.name, memberName, attempt },
    })
    return { host, member, leaseId, ctx: executionCtx }
  }

  private executeClaimedTask(
    group: TeamGroup,
    task: TeamTask,
    memberName: string,
    claim: TaskExecutionClaim,
    fireCompletionHook: boolean,
  ): Promise<string> {
    const claimKey = `${group.name}\0${task.id}\0${claim.leaseId}`
    this.activeClaims.set(claimKey, { groupName: group.name, taskId: task.id, leaseId: claim.leaseId, ctx: claim.ctx })
    const heartbeat = this.startLeaseHeartbeat(group.name, task.id, claim.leaseId, claim.ctx)
    const execution = claim.host.execute(task.title, task.id).then(async (result) => {
      const completed = this.completeTask(group, task, memberName, claim.member.agentId, claim.leaseId, result, claim.ctx)
      if (completed && fireCompletionHook) {
        await claim.ctx.hooks?.fire('task_completed', {
          cwd: claim.ctx.cwd,
          sessionId: claim.ctx.sessionId,
          agentId: claim.ctx.agentId,
          stats: `task=${task.id} "${task.title.slice(0, 40)}" member=${memberName} status=${result.status}`,
        })
      }
      return result.text
    }).catch((error: unknown) => {
      const message = (error as Error).message
      const reportId = createRuntimeId('report')
      this.completeTask(group, task, memberName, claim.member.agentId, claim.leaseId, {
        status: 'failed',
        text: `执行异常: ${message}`,
        report: { reportId, status: 'failed', summary: `执行异常: ${message}`, error: message },
      }, claim.ctx)
      return `任务执行异常: ${message}`
    }).finally(() => {
      this.stopLeaseHeartbeat(heartbeat)
      this.activeClaims.delete(claimKey)
    })
    return this.trackRun(execution)
  }

  listTasks(groupName: string): TeamTask[] {
    return this.store.listTasks(groupName)
  }

  taskBlockers(groupName: string, task: TeamTask): string[] {
    return taskBlockers(this.store.listTasks(groupName), task)
  }

  cancelTask(groupName: string, taskId: string): boolean {
    let assignee: string | undefined
    let reportId: string | undefined
    this.store.mutateTasks(groupName, (tasks) => {
      const index = tasks.findIndex((item) => item.id === taskId)
      if (index < 0) return
      const current = tasks[index]
      if (current.status !== 'in_progress' || !current.assignee || this.memberGroups.get(current.assignee) !== groupName) return
      assignee = current.assignee
      reportId = createRuntimeId('report')
      tasks[index] = {
        ...current,
        status: 'cancelled',
        result: '任务已取消',
        reportId,
        report: { reportId, status: 'cancelled', summary: '任务已取消' },
        lastError: undefined,
        nextRetryAt: undefined,
        activeAgentId: undefined,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      }
    })
    if (!assignee || !reportId) return false
    const retryKey = `${groupName}:${taskId}`
    const retryTimer = this.retryTimers.get(retryKey)
    if (retryTimer) clearTimeout(retryTimer)
    this.retryTimers.delete(retryKey)
    this.members.get(assignee)?.cancel(taskId)
    try {
      this.mail.send(assignee, this.store.loadGroup(groupName)?.lead ?? 'lead', `CANCEL 任务 ${taskId}: 任务已取消`, {
        groupId: groupName,
        kind: 'task_cancelled',
        taskId,
        correlationId: reportId,
      })
    } catch (error) {
      console.warn(`[团队] 任务 ${taskId} 取消通知失败: ${(error as Error).message}`)
    }
    emitRuntimeEvent(this.ctx, {
      type: 'task_finished',
      taskId,
      payload: { groupId: groupName, status: 'cancelled', retryable: false, reportId },
    })
    return true
  }

  updateTaskFromMember(
    groupName: string,
    memberName: string,
    taskId: string,
    patch: { status?: unknown; result?: unknown },
  ): TeamTask | null {
    if (this.memberGroups.get(memberName) !== groupName) throw new Error(`成员 ${memberName} 不属于小组 ${groupName}`)
    let requestedStatus: TeamTask['status'] | undefined
    if (patch.status !== undefined) {
      if (patch.status !== 'todo' && patch.status !== 'in_progress' && patch.status !== 'done' && patch.status !== 'failed') {
        throw new Error(`非法任务状态: ${String(patch.status)}`)
      }
      requestedStatus = patch.status
    }
    if (patch.result !== undefined && typeof patch.result !== 'string') throw new Error('任务结果必须是字符串')
    let updated: TeamTask | null = null
    let failure = ''
    let completed = false
    this.store.mutateTasks(groupName, (tasks) => {
      const index = tasks.findIndex((task) => task.id === taskId)
      if (index < 0) return
      const current = tasks[index]
      if (current.assignee && current.assignee !== memberName) {
        failure = `任务 ${taskId} 不属于成员 ${memberName}`
        return
      }
      if (requestedStatus && requestedStatus !== current.status) {
        if (current.leaseId) {
          failure = `任务 ${taskId} 正在执行中，状态由调度器管理`
          return
        }
        if (current.status !== 'todo' || (requestedStatus !== 'done' && requestedStatus !== 'failed')) {
          failure = `非法任务状态转换: ${current.status} -> ${requestedStatus}`
          return
        }
      }
      const next: TeamTask = {
        ...current,
        ...(requestedStatus ? { status: requestedStatus } : {}),
        ...(typeof patch.result === 'string' ? { result: patch.result.slice(0, 4000) } : {}),
        updatedAt: Date.now(),
      }
      tasks[index] = next
      updated = next
      completed = current.status !== 'done' && next.status === 'done'
    })
    if (failure) throw new Error(failure)
    if (completed) this.scheduleReadyTasks(groupName)
    return updated
  }

  recoverStaleTasks(groupName: string, now = Date.now(), protectLocalClaims = false): TeamTask[] {
    const isLocallyActive = (task: TeamTask): boolean => [...this.activeClaims.values()].some((claim) => (
      claim.groupName === groupName && claim.taskId === task.id && claim.leaseId === task.leaseId
    ))
    const snapshot = this.store.listTasks(groupName)
    if (!snapshot.some((task) => task.status === 'in_progress' && task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= now && (!protectLocalClaims || !isLocallyActive(task)))) return []
    let recovered: TeamTask[] = []
    this.store.mutateTasks(groupName, (tasks) => {
      recovered = recoverExpiredTasks(protectLocalClaims ? tasks.filter((task) => !isLocallyActive(task)) : tasks, now)
    })
    return recovered
  }

  private scheduleRetry(group: TeamGroup, task: TeamTask, memberName: string, delayMs: number): void {
    if (this.closed) return
    const key = `${group.name}:${task.id}`
    const existing = this.retryTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      if (this.closed) return
      let latest: TeamTask | undefined
      try {
        latest = this.store.listTasks(group.name).find((item) => item.id === task.id)
      } catch (error) {
        emitRuntimeEvent(this.ctx, {
          type: 'audit',
          taskId: task.id,
          payload: { kind: 'team_retry_timer_failed', groupId: group.name, error: (error as Error).message },
        })
        console.warn(`[团队] 任务 ${task.id} 重试检查失败: ${(error as Error).message}`)
        return
      }
      if (!latest || latest.status !== 'todo' || (latest.nextRetryAt ?? 0) > Date.now()) return
      void this.runTask(group, latest, memberName).catch((error: unknown) => {
        emitRuntimeEvent(this.ctx, {
          type: 'audit',
          taskId: task.id,
          payload: { kind: 'team_retry_execution_failed', groupId: group.name, error: (error as Error).message },
        })
        console.warn(`[团队] 任务 ${task.id} 重试启动失败: ${(error as Error).message}`)
      })
    }, Math.max(0, delayMs))
    this.retryTimers.set(key, timer)
  }

  private schedulePendingRetries(groupName: string): void {
    const group = this.store.loadGroup(groupName)
    if (!group) return
    const now = Date.now()
    for (const task of this.store.listTasks(groupName)) {
      if (task.status !== 'todo' || !task.assignee || !task.nextRetryAt || task.nextRetryAt <= now) continue
      if (!this.members.has(task.assignee) || this.memberGroups.get(task.assignee) !== groupName) continue
      this.scheduleRetry(group, task, task.assignee, task.nextRetryAt - now)
    }
  }

  private completeTask(
    group: TeamGroup,
    task: TeamTask,
    memberName: string,
    agentId: string | undefined,
    leaseId: string,
    result: { status: 'done' | 'failed'; text: string; report: TeamTaskReport },
    ctx: ToolContext = this.ctx,
  ): boolean {
    let applied = false
    let retryable = false
    let shutdownRequeue = false
    let nextRetryAt: number | undefined
    this.store.mutateTasks(group.name, (tasks) => {
      const index = tasks.findIndex((item) => item.id === task.id)
      if (index < 0) return
      const current = tasks[index]
      if (current.status !== 'in_progress' || current.leaseId !== leaseId) return
      shutdownRequeue = this.closed && result.status === 'failed'
      retryable = !shutdownRequeue && result.status === 'failed' && (current.attempt ?? 0) < (current.maxAttempts ?? 1)
      nextRetryAt = retryable ? Date.now() + Math.min(30000, 1000 * 2 ** Math.max(0, (current.attempt ?? 1) - 1)) : undefined
      tasks[index] = {
        ...current,
        status: shutdownRequeue || retryable ? 'todo' : result.status,
        attempt: shutdownRequeue ? Math.max(0, (current.attempt ?? 1) - 1) : current.attempt,
        result: result.text.slice(0, 4000),
        reportId: result.report.reportId,
        report: result.report,
        lastError: shutdownRequeue ? '调度器关闭，任务已重新排队' : result.status === 'failed' ? result.report.error ?? result.text.slice(0, 500) : undefined,
        nextRetryAt: shutdownRequeue ? Date.now() : nextRetryAt,
        activeAgentId: undefined,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      }
      applied = true
    })
    if (!applied) {
      emitRuntimeEvent(ctx, {
        type: 'audit',
        taskId: task.id,
        agentId,
        payload: { kind: 'team_stale_completion_dropped', groupId: group.name, leaseId, reportId: result.report.reportId },
      })
      return false
    }
    const protocol = retryable || shutdownRequeue ? 'RETRY' : result.status === 'done' ? 'IDLE' : 'ERR'
    this.mail.send(memberName, group.lead, `${protocol} 任务 ${task.id}: ${result.text.split('\n')[0].slice(0, 200)}`, {
      groupId: group.name,
      kind: retryable || shutdownRequeue ? 'task_retry' : 'task_result',
      taskId: task.id,
      correlationId: result.report.reportId,
    })
    emitRuntimeEvent(ctx, {
      type: 'task_finished',
      taskId: task.id,
      agentId,
      payload: { groupId: group.name, status: shutdownRequeue ? 'todo' : result.status, retryable: retryable || shutdownRequeue, reportId: result.report.reportId, nextRetryAt },
    })
    if (retryable && nextRetryAt) this.scheduleRetry(group, { ...task, nextRetryAt }, memberName, Math.max(0, nextRetryAt - Date.now()))
    if (result.status === 'done') this.scheduleReadyTasks(group.name)
    return true
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
      const claim = this.claimTask(group, task, task.assignee)
      if (typeof claim === 'string') continue
      void this.executeClaimedTask(group, task, task.assignee, claim, false)
      scheduled.push(task.id)
    }
    return scheduled
  }

  restoreGroup(groupName: string): void {
    this.managedGroups.add(groupName)
    this.recoverStaleTasks(groupName)
    this.schedulePendingRetries(groupName)
    this.scheduleReadyTasks(groupName)
  }

  addTask(groupName: string, title: string, assignee?: string, dependsOn: string[] = [], maxAttempts = 1, dispatchId?: string): TeamTask {
    if (this.closed) throw new Error('TeamManager 已关闭，无法创建任务')
    this.managedGroups.add(groupName)
    const group = this.store.loadGroup(groupName)
    if (!group) throw new Error(`小组不存在: ${groupName}`)
    const normalizedTitle = title.trim()
    if (!normalizedTitle) throw new Error('任务标题不能为空')
    if (normalizedTitle.length > TASK_TITLE_MAX_CHARS) throw new Error(`任务标题不能超过 ${TASK_TITLE_MAX_CHARS} 个字符`)
    if (assignee && (!group.members.some((member) => member.name === assignee) || this.memberGroups.get(assignee) !== groupName || !this.members.has(assignee))) {
      throw new Error(`成员 ${assignee} 不属于小组 ${groupName} 或尚未启动`)
    }
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1 || maxAttempts > TASK_MAX_ATTEMPTS) {
      throw new Error(`最多执行次数必须在 1-${TASK_MAX_ATTEMPTS} 之间`)
    }
    const normalizedDeps = [...new Set(dependsOn)]
    const id = createRuntimeId('task')
    const now = Date.now()
    const task: TeamTask = {
      id,
      title: normalizedTitle,
      status: 'todo',
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      maxAttempts: Math.floor(maxAttempts),
      ...(dispatchId ? { dispatchId } : {}),
      ...(normalizedDeps.length ? { depends_on: normalizedDeps } : {}),
      ...(assignee ? { assignee } : {}),
    }
    let dependencyError: string | null = null
    this.store.mutateTasks(groupName, (tasks) => {
      dependencyError = validateTaskDependencies(tasks, id, normalizedDeps)
      if (!dependencyError) tasks.push(task)
    })
    if (dependencyError) throw new Error(dependencyError)
    emitRuntimeEvent(this.ctx, {
      type: 'task_created',
      taskId: task.id,
      payload: { groupId: groupName, title: normalizedTitle, assignee, dependsOn: normalizedDeps },
    })
    void this.ctx.hooks?.fire('task_created', {
      cwd: this.ctx.cwd,
      sessionId: this.ctx.sessionId,
      agentId: this.ctx.agentId,
      stats: `task=${task.id} "${normalizedTitle.slice(0, 60)}"${assignee ? ` assignee=${assignee}` : ''}`,
    })
    return task
  }
}
