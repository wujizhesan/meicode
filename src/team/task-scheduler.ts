import type { ToolContext } from '../tools/index.ts'
import { createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'
import type { TeamGroupStore } from './group.ts'
import type { TeamMail } from './mail.ts'
import type { MemberHost } from './member.ts'
import { MemberPersistenceError } from './member.ts'
import type { MailMessage, TeamGroup, TeamMember, TeamTask, TeamTaskOutcome, TeamTaskReport, TeamTaskSettlement } from './types.ts'
import { matchesTaskSettlement, readyTasks, recoverExpiredTasks, taskBlockers, validateTaskDependencies } from './task-graph.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import { isTeamActorName, parseTaskDependencies, parseTaskMaxAttempts, parseTaskTitle, parseTaskUpdate } from './validation.ts'

const TASK_LEASE_MS = 10 * 60 * 1000
const TASK_EXECUTION_TIMEOUT = Symbol('team_task_execution_timeout')
// 到期重试没交到成员手上时，重新排下一次检查的间隔（成员空闲通常需要几十毫秒的量级）
const RETRY_HANDOFF_MS = 200
// 等成员空闲时的安全网轮询间隔：正常情况下由 whenIdle() 在空闲瞬间唤醒，这里只防通知漏发
const RETRY_IDLE_POLL_MS = 2000

interface TaskExecutionClaim {
  task: TeamTask
  host: MemberHost
  member: TeamMember
  leaseId: string
  ctx: ToolContext
  controller: AbortController
}

interface ActiveTaskClaim {
  groupName: string
  taskId: string
  leaseId: string
  memberName: string
  agentId?: string
  host: MemberHost
  controller: AbortController
  ctx: ToolContext
  settled?: boolean
}

interface PendingTaskCompletion {
  entry: TeamTaskSettlement
  ctx: ToolContext
  onSaved?: () => Promise<void>
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

function sameTaskNotification(left: MailMessage, right: MailMessage): boolean {
  return left.messageId === right.messageId && left.from === right.from && left.to === right.to
    && left.groupId === right.groupId && left.taskId === right.taskId && left.correlationId === right.correlationId
    && left.kind === right.kind && left.body === right.body && left.ts === right.ts
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
  private readonly handoffTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly leaseHeartbeats = new Set<ReturnType<typeof setInterval>>()
  private readonly activeRuns = new Set<Promise<unknown>>()
  private readonly activeClaims = new Map<string, ActiveTaskClaim>()
  private readonly pendingCancellations = new Map<string, TeamTaskSettlement>()
  private readonly pendingCompletions = new Map<string, PendingTaskCompletion>()
  private readonly closeController = new AbortController()
  private readonly notificationGroups = new Set<string>()
  private readonly flushingNotifications = new Set<string>()
  private notificationTimer: ReturnType<typeof setInterval> | undefined
  private settlementTimer: ReturnType<typeof setInterval> | undefined
  private flushingSettlements = false
  private cancellationTimer: ReturnType<typeof setInterval> | undefined
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
      this.closeController.abort()
      for (const timer of this.retryTimers.values()) clearTimeout(timer)
      this.retryTimers.clear()
      for (const timer of this.handoffTimers) clearTimeout(timer)
      this.handoffTimers.clear()
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
      this.flushCancellations()
      this.flushCompletions()
      for (const groupName of [...this.notificationGroups]) this.flushTaskNotifications(groupName)
      clearInterval(this.notificationTimer)
      this.notificationTimer = undefined
      clearInterval(this.cancellationTimer)
      this.cancellationTimer = undefined
      clearInterval(this.settlementTimer)
      this.settlementTimer = undefined
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
      if ([...this.pendingCancellations.values()].some((entry) => this.matchesClaim(entry, claim))
        || [...this.pendingCompletions.values()].some((pending) => pending.entry.agentId === claim.agentId && this.matchesClaim(pending.entry, claim))) continue
      let cancelling = false
      try {
        this.store.mutateTasks(claim.groupName, (tasks) => {
          const task = tasks.find((item) => item.id === claim.taskId)
          if (!task || task.status !== 'in_progress' || task.leaseId !== claim.leaseId
            || task.assignee !== claim.memberName || task.activeAgentId !== claim.agentId) return false
          const entries = this.store.loadTaskSettlements(claim.groupName)
          cancelling = this.captureCancellations(claim.groupName, task, entries)
          const completed = this.captureCompletions(claim.groupName, task, entries)
          if (cancelling || completed) return false
          task.status = 'todo'
          task.attempt = Math.max(0, (task.attempt ?? 1) - 1)
          task.lastError = '调度器关闭，任务已重新排队'
          task.nextRetryAt = now
          task.activeAgentId = undefined
          task.leaseId = undefined
          task.leaseExpiresAt = undefined
          task.updatedAt = now
          return true
        })
        if (cancelling) claim.controller.abort()
      } catch (error) {
        emitRuntimeEvent(claim.ctx, {
          type: 'audit',
          taskId: claim.taskId,
          payload: { kind: 'team_shutdown_release_failed', groupId: claim.groupName, leaseId: claim.leaseId, error: (error as Error).message },
        })
      }
    }
    this.flushCancellations()
    this.flushCompletions()
  }

  private trackRun<T>(promise: Promise<T>): Promise<T> {
    this.activeRuns.add(promise)
    void promise.then(
      () => this.activeRuns.delete(promise),
      () => this.activeRuns.delete(promise),
    )
    return promise
  }

  private startLeaseHeartbeat(groupName: string, taskId: string, memberName: string, claim: TaskExecutionClaim): ReturnType<typeof setInterval> {
    const { leaseId, ctx, controller } = claim
    let confirmedExpiry = claim.task.leaseExpiresAt
    const timer = setInterval(() => {
      let renewedUntil: number | undefined
      let cancelling = false
      try {
        this.store.mutateTasks(groupName, (tasks) => {
          const task = tasks.find((item) => item.id === taskId)
          if (!task || task.status !== 'in_progress' || task.leaseId !== leaseId || task.assignee !== memberName || task.activeAgentId !== claim.member.agentId) return false
          cancelling = this.captureCancellations(groupName, task)
          if (cancelling) return false
          const now = Date.now()
          if (task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= now) return false
          renewedUntil = now + this.leaseMs
          task.leaseExpiresAt = renewedUntil
          return true
        }, { required: true })
      } catch (error) {
        emitRuntimeEvent(ctx, {
          type: 'audit',
          taskId,
          payload: { kind: 'team_lease_heartbeat_failed', groupId: groupName, leaseId, error: (error as Error).message },
        })
        console.warn(`[团队] 任务 ${taskId} 租约续期失败: ${(error as Error).message}`)
        if (confirmedExpiry !== undefined && confirmedExpiry <= Date.now()) {
          this.stopLeaseHeartbeat(timer)
          controller.abort()
        }
        return
      }
      if (renewedUntil === undefined) {
        this.stopLeaseHeartbeat(timer)
        controller.abort()
      } else confirmedExpiry = renewedUntil
      if (cancelling) { this.flushCancellations(); this.startCancellationTimer() }
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
    void this.executeClaimedTask(group, memberName, claim, false)
    return claim.member.needsApproval
      ? `已派发任务 ${task.id} 给 ${memberName}（需审批，成员已发 PLAN 等待 Lead 决定）`
      : `已指派成员 ${memberName} 执行任务 ${task.id}`
  }

  async runTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    if (this.closed) return 'TeamManager 已关闭，无法执行任务'
    const claim = this.claimTask(group, task, memberName)
    if (typeof claim === 'string') return claim
    const execution = this.executeClaimedTask(group, memberName, claim, true)
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
    this.refreshSettlements(group.name)
    this.managedGroups.add(group.name)
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    if (this.memberGroups.get(memberName) !== group.name) return `成员 ${memberName} 不属于小组 ${group.name}`
    let member: TeamMember | undefined
    let bindingChanged = false
    let identityChanged = false
    const tasks = this.readTasksWithNotifications(group.name)
    const current = tasks.find((item) => item.id === task.id)
    if (!current) return `任务不存在: ${task.id}`
    if (this.isCancelling(group.name, current)) return `任务 ${task.id} 正在取消，等待取消记录保存`
    if (current.assignee !== task.assignee && current.assignee !== memberName) return `任务 ${task.id} 分派已变更，请重新读取后执行`
    if ((current.nextRetryAt ?? 0) > Date.now()) return `任务 ${task.id} 正在等待重试`
    const blockers = taskBlockers(tasks, current)
    if (blockers.length > 0) return `任务 ${task.id} 仍被依赖阻塞: ${blockers.join(', ')}`
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    if ((current.attempt ?? 0) >= (current.maxAttempts ?? 1)) return `任务 ${task.id} 已达到最大执行次数`
    const leaseId = createRuntimeId('lease')
    const claimed = this.store.claimTask(group.name, task.id, (current) => ({
      status: 'in_progress',
      assignee: memberName,
      attempt: (current.attempt ?? 0) + 1,
      activeAgentId: member!.agentId,
      leaseId,
      leaseExpiresAt: Date.now() + this.leaseMs,
      nextRetryAt: undefined,
      updatedAt: Date.now(),
    }), (latest, tasks) => {
      member = this.store.loadGroup(group.name, { strict: true })?.members.find((item) => item.name === memberName)
      bindingChanged = !member || !host.matchesMember(member)
      identityChanged = !bindingChanged && !this.store.isMemberIdentityUnique(group.name, member!)
      return !bindingChanged
        && !identityChanged
        && latest.assignee === current.assignee
        && (latest.nextRetryAt ?? 0) <= Date.now()
        && (latest.attempt ?? 0) < (latest.maxAttempts ?? 1)
        && taskBlockers(tasks, latest).length === 0
        && !this.isCancelling(group.name, latest)
        && !this.store.loadTaskSettlements(group.name).some((entry) => entry.kind === 'cancel' && this.matchesCancellation(entry, latest))
    })
    if (bindingChanged) return `成员 ${memberName} 已关闭、离线或配置已变更，请恢复成员后执行`
    if (identityChanged) return `成员 ${memberName} 持久化身份冲突，请修复花名册后执行`
    if (!claimed || !member) return `任务 ${task.id} 已被其他执行者领取`
    const executionCtx: ToolContext = { ...this.ctx }
    emitRuntimeEvent(executionCtx, {
      type: 'task_assigned',
      taskId: task.id,
      agentId: member.agentId,
      payload: { groupId: group.name, memberName, attempt: claimed.attempt },
    })
    return { task: claimed, host, member, leaseId, ctx: executionCtx, controller: new AbortController() }
  }

  private executeClaimedTask(
    group: TeamGroup,
    memberName: string,
    claim: TaskExecutionClaim,
    fireCompletionHook: boolean,
  ): Promise<string> {
    const task = claim.task
    const claimKey = `${group.name}\0${task.id}\0${claim.leaseId}`
    this.activeClaims.set(claimKey, { groupName: group.name, taskId: task.id, leaseId: claim.leaseId, memberName,
      agentId: claim.member.agentId, host: claim.host, controller: claim.controller, ctx: claim.ctx })
    const heartbeat = this.startLeaseHeartbeat(group.name, task.id, memberName, claim)
    const execution = (async () => {
      let result: TeamTaskOutcome
      let response: string | undefined
      try { result = await claim.host.execute(task.title, task.id, claim.controller.signal, claim.leaseId) }
      catch (error) {
        if (error instanceof MemberPersistenceError) {
          const text = `${error.outcome.text}\n（${error.message}）`
          result = { ...error.outcome, text, report: { ...error.outcome.report, summary: text.slice(0, 4000), error: error.outcome.report.error ?? error.message } }
        } else {
          const message = (error as Error).message
          const reportId = createRuntimeId('report')
          result = { status: 'failed', text: `执行异常: ${message}`, report: { reportId, status: 'failed', summary: `执行异常: ${message}`, error: message } }
          response = `任务执行异常: ${message}`
        }
      }
      const entry: TeamTaskSettlement = {
        kind: 'result', groupName: group.name, taskId: task.id, memberName, leaseId: claim.leaseId,
        agentId: claim.member.agentId, sessionId: claim.ctx.sessionId, parentAgentId: claim.ctx.agentId,
        reportId: result.report.reportId, result: structuredClone(result),
        ...(this.closed && result.status === 'failed' && result.interrupted === true ? { requeueOnShutdown: true } : {}),
      }
      const pending: PendingTaskCompletion = { entry, ctx: claim.ctx, onSaved: fireCompletionHook ? async () => {
        const signal = claim.ctx.signal ? AbortSignal.any([claim.ctx.signal, this.closeController.signal]) : this.closeController.signal
        try {
          await resolveOnAbort(async () => claim.ctx.hooks?.fire('task_completed', {
            cwd: claim.ctx.cwd, sessionId: claim.ctx.sessionId, agentId: claim.ctx.agentId,
            stats: `task=${task.id} "${task.title.slice(0, 40)}" member=${memberName} status=${result.status}`,
          }, signal), signal, undefined)
        } catch (error) { console.warn(`[团队] 任务 ${task.id} 完成 Hook 失败: ${(error as Error).message}`) }
      } : undefined }
      const settlementKey = this.settlementKey(entry)
      this.pendingCompletions.set(settlementKey, pending)
      this.stageSettlement(entry)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const completed = this.persistCompletion(pending)
          this.pendingCompletions.delete(settlementKey)
          this.clearSettlement(entry)
          const active = this.activeClaims.get(claimKey)
          if (active) active.settled = true
          if (completed) await pending.onSaved?.()
          return response ?? result.text
        } catch (error) {
          if (attempt === 0) console.warn(`[团队] 任务 ${task.id} 结果待保存: ${(error as Error).message}`)
          if (attempt === 2 || this.closed) break
          let timer: ReturnType<typeof setTimeout> | undefined
          try { await resolveOnAbort(() => new Promise<void>((done) => { timer = setTimeout(done, 100) }), this.closeController.signal, undefined) }
          finally { clearTimeout(timer) }
        }
      }
      return `${response ?? result.text}\n（任务结果待保存，将自动补存）`
    })().finally(() => {
      this.stopLeaseHeartbeat(heartbeat)
      this.activeClaims.delete(claimKey)
      this.startSettlementTimer()
    })
    return this.trackRun(execution)
  }

  listTasks(groupName: string): TeamTask[] {
    this.refreshSettlements(groupName)
    return this.readTasksWithNotifications(groupName)
  }

  private readTasksWithNotifications(groupName: string): TeamTask[] {
    const tasks = this.store.listTasks(groupName)
    if (tasks.some((task) => task.notifications?.length)) {
      this.flushTaskNotifications(groupName, tasks)
      return this.store.listTasks(groupName)
    }
    return tasks
  }

  private settlementKey(entry: TeamTaskSettlement): string {
    return JSON.stringify([entry.groupName, entry.kind, entry.taskId, entry.leaseId, entry.reportId])
  }

  private stageSettlement(entry: TeamTaskSettlement): void {
    try { this.store.saveTaskSettlement(entry) }
    catch (error) { console.warn(`[团队] 任务 ${entry.taskId} 补存日志保存失败: ${(error as Error).message}`) }
  }

  private clearSettlement(entry: TeamTaskSettlement): void {
    try { this.store.deleteTaskSettlement(entry) }
    catch (error) { console.warn(`[团队] 任务 ${entry.taskId} 补存日志清理失败: ${(error as Error).message}`) }
  }

  private startSettlementTimer(): void {
    if (this.closed || this.settlementTimer || this.pendingCompletions.size === 0) return
    this.settlementTimer = setInterval(() => {
      this.flushCancellations()
      this.flushCompletions()
    }, 500)
    this.settlementTimer.unref()
  }

  private refreshSettlements(groupName: string): void {
    if (this.flushingSettlements) return
    this.flushingSettlements = true
    try {
      for (const entry of this.store.loadTaskSettlements(groupName)) {
        const key = this.settlementKey(entry)
        if (entry.kind === 'cancel') {
          if (!this.pendingCancellations.has(key)) this.pendingCancellations.set(key, entry)
        } else {
          if (!this.pendingCompletions.has(key)) this.pendingCompletions.set(key, {
            entry, ctx: { ...this.ctx, sessionId: entry.sessionId, agentId: entry.parentAgentId },
          })
        }
      }
      this.flushCancellations()
      this.flushCompletions()
      this.startCancellationTimer()
      this.startSettlementTimer()
    } finally { this.flushingSettlements = false }
  }

  private persistCompletion(pending: PendingTaskCompletion): boolean {
    const entry = pending.entry
    const group = this.store.loadGroup(entry.groupName, { strict: true })
    if (!group) throw new Error(`小组不存在，无法保存任务结果: ${entry.groupName}`)
    const task = this.store.listTasks(entry.groupName, { required: true }).find((task) => task.id === entry.taskId)
    if (!task) return false
    return this.completeTask(group, task, entry.memberName, entry.agentId, entry.leaseId!, entry.result!, pending.ctx, entry.requeueOnShutdown)
  }

  private flushCompletions(): void {
    const wasFlushing = this.flushingSettlements
    this.flushingSettlements = true
    try {
      for (const [key, pending] of this.pendingCompletions) {
        const entry = pending.entry
        const claim = this.activeClaims.get(`${entry.groupName}\0${entry.taskId}\0${entry.leaseId}`)
        if (claim && this.matchesClaim(entry, claim)) continue
        try {
          this.stageSettlement(pending.entry)
          const completed = this.persistCompletion(pending)
          this.pendingCompletions.delete(key)
          this.clearSettlement(pending.entry)
          // trackRun 内部已挂 then/catch 处理拒绝；这里丢弃返回值是刻意的，加 void 显式表明意图
          if (completed && pending.onSaved) void this.trackRun(pending.onSaved())
        } catch { }
      }
    } finally { this.flushingSettlements = wasFlushing }
    if (this.pendingCompletions.size === 0) {
      clearInterval(this.settlementTimer)
      this.settlementTimer = undefined
    }
  }

  taskBlockers(groupName: string, task: TeamTask): string[] {
    return taskBlockers(this.store.listTasks(groupName), task)
  }

  private taskNotification(groupName: string, taskId: string, from: string, to: string, reportId: string, kind: string, body: string): MailMessage {
    return {
      messageId: `team:${JSON.stringify([groupName, taskId, reportId])}`,
      groupId: groupName, taskId, from, to, correlationId: reportId, kind, body,
      ts: Date.now(), read: false, summary: body.split('\n')[0].slice(0, 80),
    }
  }

  private flushTaskNotifications(groupName: string, snapshot?: readonly TeamTask[]): void {
    if (this.flushingNotifications.has(groupName)) return
    this.flushingNotifications.add(groupName)
    let pending = false
    try {
      for (const task of snapshot ?? this.store.listTasks(groupName)) {
        for (const message of task.notifications ?? []) {
          try {
            this.mail.send(message.from, message.to, message.body, {
              messageId: message.messageId, ts: message.ts, groupId: message.groupId,
              kind: message.kind, taskId: message.taskId, correlationId: message.correlationId,
            })
            this.store.mutateTasks(groupName, (tasks) => {
              const current = tasks.find((item) => item.id === task.id)
              if (!current?.notifications?.some((item) => sameTaskNotification(item, message))) return false
              current.notifications = current.notifications.filter((item) => !sameTaskNotification(item, message))
              if (current.notifications.length === 0) delete current.notifications
              return true
            })
          } catch (error) {
            pending = true
            console.warn(`[团队] 任务 ${task.id} 通知待发送或确认: ${(error as Error).message}`)
            break
          }
        }
      }
      pending = this.store.listTasks(groupName).some((task) => Boolean(task.notifications?.length))
    } catch (error) {
      pending = true
      console.warn(`[团队] 小组 ${groupName} 通知恢复失败: ${(error as Error).message}`)
    } finally { this.flushingNotifications.delete(groupName) }
    if (pending) {
      this.notificationGroups.add(groupName)
      if (!this.closed && !this.notificationTimer) {
        this.notificationTimer = setInterval(() => {
          for (const name of [...this.notificationGroups]) this.flushTaskNotifications(name)
        }, 500)
        this.notificationTimer.unref()
      }
    } else {
      this.notificationGroups.delete(groupName)
      if (this.notificationGroups.size === 0) {
        clearInterval(this.notificationTimer)
        this.notificationTimer = undefined
      }
    }
  }

  cancelTask(groupName: string, taskId: string): boolean {
    const key = `${groupName}:${taskId}`
    let current: TeamTask | undefined, readError: unknown, readFailed = false
    try { current = this.store.listTasks(groupName, { required: true }).find((task) => task.id === taskId) }
    catch (error) { readFailed = true; readError = error }
    const claims = [...this.activeClaims.values()].filter((item) => item.groupName === groupName && item.taskId === taskId && !item.settled)
    const completions = [...this.pendingCompletions.values()].filter((item) => item.entry.groupName === groupName && item.entry.taskId === taskId)
    let claim: ActiveTaskClaim | undefined, completion: PendingTaskCompletion | undefined
    if (readFailed) {
      claim = claims.at(-1)
      completion = claim ? completions.find((item) => this.matchesClaim(item.entry, claim!)) : completions.at(-1)
    } else if (current) {
      if (current.status === 'in_progress') claim = claims.find((item) => item.leaseId === current.leaseId && item.memberName === current.assignee && item.agentId === current.activeAgentId)
      completion = completions.find((item) => this.matchesCancellation(item.entry, current!))
    }
    let request: TeamTaskSettlement | undefined
    for (const [pendingKey, candidate] of this.pendingCancellations) {
      if (candidate.groupName !== groupName || candidate.taskId !== taskId) continue
      if (readFailed ? claim && !this.matchesClaim(candidate, claim) : !current || !this.matchesCancellation(candidate, current)) {
        this.pendingCancellations.delete(pendingKey)
        this.clearSettlement(candidate)
      } else request ??= candidate
    }
    const wasPending = request !== undefined
    if (!request && claim) request = { kind: 'cancel', groupName, taskId, memberName: claim.memberName, leaseId: claim.leaseId, agentId: claim.agentId,
      reportId: createRuntimeId('report'), sessionId: claim.ctx.sessionId, parentAgentId: claim.ctx.agentId }
    if (!request && completion) request = { ...completion.entry, kind: 'cancel', result: undefined, requeueOnShutdown: undefined, reportId: createRuntimeId('report') }
    if (!request) {
      if (readFailed) {
        if ((readError as NodeJS.ErrnoException)?.code === 'ENOENT' && !this.store.loadGroup(groupName, { strict: true })) return false
        throw readError
      }
      if (!current || (current.status !== 'todo' && current.status !== 'in_progress')) return false
      const group = this.store.loadGroup(groupName, { strict: true })
      if (!group || (current.assignee && !group.members.some((member) => member.name === current.assignee))) return false
      if (current.status === 'todo') {
        if (current.leaseId) return false
        request = { kind: 'cancel', groupName, taskId, memberName: current.assignee ?? group.lead, reportId: createRuntimeId('report'), sessionId: this.ctx.sessionId, parentAgentId: this.ctx.agentId,
          queuedTask: { title: current.title, assignee: current.assignee, attempt: current.attempt, updatedAt: current.updatedAt, reportId: current.reportId } }
      } else {
        if (!current.assignee) return false
        request = { kind: 'cancel', groupName, taskId, memberName: current.assignee, leaseId: current.leaseId, agentId: current.activeAgentId,
          reportId: createRuntimeId('report'), sessionId: this.ctx.sessionId, parentAgentId: this.ctx.agentId }
      }
    }
    const settlementKey = this.settlementKey(request)
    this.pendingCancellations.set(settlementKey, request)
    const stoppedClaim = claims.find((item) => this.matchesClaim(request!, item))
    if (stoppedClaim) {
      stoppedClaim.controller.abort()
      stoppedClaim.host.cancel(taskId, stoppedClaim.controller.signal)
    }
    this.stageSettlement(request)
    const retryTimer = this.retryTimers.get(key)
    if (retryTimer) clearTimeout(retryTimer)
    this.retryTimers.delete(key)
    try {
      const saved = this.persistCancellation(request)
      this.pendingCancellations.delete(settlementKey)
      this.clearSettlement(request)
      return saved || stoppedClaim !== undefined || completion !== undefined || wasPending
    } catch (error) {
      if (!claim && !completion && !wasPending && !request.queuedTask) { this.startCancellationTimer(); throw error }
      console.warn(`[团队] 任务 ${taskId} 取消记录待保存: ${(error as Error).message}`)
      this.startCancellationTimer()
      return true
    }
  }

  private startCancellationTimer(): void {
    if (this.closed || this.cancellationTimer || this.pendingCancellations.size === 0) return
    this.cancellationTimer = setInterval(() => this.flushCancellations(), 500)
    this.cancellationTimer.unref()
  }

  private flushCancellations(): void {
    for (const [key, request] of this.pendingCancellations) {
      try { this.stageSettlement(request); this.persistCancellation(request); this.pendingCancellations.delete(key); this.clearSettlement(request) }
      catch { }
    }
    if (this.pendingCancellations.size === 0) {
      clearInterval(this.cancellationTimer)
      this.cancellationTimer = undefined
    }
  }

  private persistCancellation(request: TeamTaskSettlement): boolean {
    const { groupName, taskId, memberName: assignee, reportId } = request
    let applied = false
    this.store.mutateTasks(groupName, (tasks) => {
      const index = tasks.findIndex((item) => item.id === taskId)
      if (index < 0) return false
      const current = tasks[index]
      if (!this.matchesCancellation(request, current)) return false
      const group = this.store.loadGroup(groupName, { strict: true })
      if (!group) throw new Error(`小组不存在，无法保存任务取消: ${groupName}`)
      tasks[index] = {
        ...current,
        status: 'cancelled',
        result: '任务已取消',
        reportId,
        report: { reportId, status: 'cancelled', summary: '任务已取消' },
        notifications: [...(current.notifications ?? []), this.taskNotification(groupName, taskId, assignee, group.lead, reportId, 'task_cancelled', `CANCEL 任务 ${taskId}: 任务已取消`)],
        lastError: undefined,
        nextRetryAt: undefined,
        activeAgentId: undefined,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      }
      applied = true
      return true
    }, { required: true })
    if (!applied) return false
    this.flushTaskNotifications(groupName)
    emitRuntimeEvent(this.ctx, {
      type: 'task_finished',
      taskId,
      payload: { groupId: groupName, status: 'cancelled', retryable: false, reportId },
    })
    return true
  }

  private matchesCancellation(request: TeamTaskSettlement, task: TeamTask): boolean {
    return matchesTaskSettlement(request, task)
  }

  private matchesClaim(request: TeamTaskSettlement, claim: ActiveTaskClaim): boolean {
    return !request.queuedTask && request.groupName === claim.groupName && request.taskId === claim.taskId
      && request.memberName === claim.memberName && request.leaseId === claim.leaseId
      && (request.agentId === undefined || request.agentId === claim.agentId)
  }

  private isCancelling(groupName: string, task: TeamTask): boolean {
    return [...this.pendingCancellations.values()].some((request) => request.groupName === groupName && this.matchesCancellation(request, task))
  }

  private captureCancellations(groupName: string, task: TeamTask, entries: readonly TeamTaskSettlement[] = this.store.loadTaskSettlements(groupName)): boolean {
    for (const entry of entries) {
      if (entry.kind === 'cancel' && this.matchesCancellation(entry, task)) this.pendingCancellations.set(this.settlementKey(entry), entry)
    }
    return this.isCancelling(groupName, task)
  }

  private matchesCompletion(entry: TeamTaskSettlement, task: TeamTask): boolean {
    return entry.kind === 'result' && entry.agentId === task.activeAgentId && this.matchesCancellation(entry, task)
  }

  private hasPendingCompletion(groupName: string, task: TeamTask): boolean {
    return [...this.pendingCompletions.values()].some((pending) => pending.entry.groupName === groupName && this.matchesCompletion(pending.entry, task))
  }

  private captureCompletions(groupName: string, task: TeamTask, entries: readonly TeamTaskSettlement[]): boolean {
    for (const entry of entries) {
      if (!this.matchesCompletion(entry, task)) continue
      const key = this.settlementKey(entry)
      if (!this.pendingCompletions.has(key)) this.pendingCompletions.set(key, {
        entry, ctx: { ...this.ctx, sessionId: entry.sessionId, agentId: entry.parentAgentId },
      })
    }
    return this.hasPendingCompletion(groupName, task)
  }

  updateTaskFromMember(
    groupName: string,
    memberName: string,
    taskId: string,
    patch: { status?: unknown; result?: unknown },
  ): TeamTask | null {
    if (this.memberGroups.get(memberName) !== groupName) throw new Error(`成员 ${memberName} 不属于小组 ${groupName}`)
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('任务 ID 必须是非空字符串')
    const update = parseTaskUpdate(patch), requestedStatus = update.status
    let updated: TeamTask | null = null
    let failure = ''
    let completed = false
    let cancelling = false
    this.store.mutateTasks(groupName, (tasks) => {
      const index = tasks.findIndex((task) => task.id === taskId)
      if (index < 0) return false
      const current = tasks[index]
      if (current.assignee && current.assignee !== memberName) {
        failure = `任务 ${taskId} 不属于成员 ${memberName}`
        return false
      }
      if (current.status === 'cancelled') {
        failure = `任务 ${taskId} 已取消`
        return false
      }
      cancelling = this.captureCancellations(groupName, current)
      if (cancelling) {
        failure = `任务 ${taskId} 正在取消，等待取消记录保存`
        return false
      }
      if (requestedStatus && requestedStatus !== current.status) {
        if (current.leaseId) {
          failure = `任务 ${taskId} 正在执行中，状态由调度器管理`
          return false
        }
        if (current.status !== 'todo' || (requestedStatus !== 'done' && requestedStatus !== 'failed')) {
          failure = `非法任务状态转换: ${current.status} -> ${requestedStatus}`
          return false
        }
      }
      const next: TeamTask = {
        ...current,
        ...(requestedStatus ? { status: requestedStatus } : {}),
        ...(update.result !== undefined ? { result: update.result.slice(0, 4000) } : {}),
        updatedAt: Date.now(),
      }
      tasks[index] = next
      updated = next
      completed = current.status !== 'done' && next.status === 'done'
      return true
    })
    if (cancelling) { this.flushCancellations(); this.startCancellationTimer() }
    if (failure) throw new Error(failure)
    if (completed) this.scheduleReadyTasks(groupName)
    return updated
  }

  recoverStaleTasks(groupName: string, now = Date.now(), protectLocalClaims = false): TeamTask[] {
    this.refreshSettlements(groupName)
    const isLocallyActive = (task: TeamTask): boolean => [...this.activeClaims.values()].some((claim) => (
      claim.groupName === groupName && claim.taskId === task.id && claim.leaseId === task.leaseId
    ))
    const isProtected = (task: TeamTask): boolean => {
      return (protectLocalClaims && isLocallyActive(task)) || this.isCancelling(groupName, task)
        || this.hasPendingCompletion(groupName, task)
    }
    const snapshot = this.readTasksWithNotifications(groupName)
    if (!snapshot.some((task) => task.status === 'in_progress' && task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= now && !isProtected(task))) return []
    const group = this.store.loadGroup(groupName, { strict: true })
    if (!group) throw new Error(`小组不存在，无法恢复任务: ${groupName}`)
    const recovered: TeamTask[] = []
    this.store.mutateTasks(groupName, (tasks) => {
      const entries = this.store.loadTaskSettlements(groupName)
      for (const task of tasks) {
        if (task.status !== 'in_progress' || task.leaseExpiresAt === undefined || task.leaseExpiresAt > now) continue
        this.captureCancellations(groupName, task, entries)
        this.captureCompletions(groupName, task, entries)
      }
      const expiredIds = new Set(recoverExpiredTasks(tasks.filter((task) => !isProtected(task)), now).map((task) => task.id))
      for (const task of tasks) {
        if (!expiredIds.has(task.id)) continue
        const reportId = createRuntimeId('report'), reason = task.lastError!
        const retryable = task.status === 'todo'
        task.result = reason
        task.reportId = reportId
        task.report = { reportId, status: 'failed', summary: reason, error: reason }
        task.notifications = [...(task.notifications ?? []), this.taskNotification(groupName, task.id,
          task.assignee && isTeamActorName(task.assignee) ? task.assignee : group.lead, group.lead, reportId,
          retryable ? 'task_retry' : 'task_result', `${retryable ? 'RETRY' : 'ERR'} 任务 ${task.id}: ${reason}`)]
        recovered.push(structuredClone(task))
      }
      return recovered.length > 0
    })
    if (recovered.length > 0) {
      this.flushTaskNotifications(groupName)
      for (const task of recovered) emitRuntimeEvent(this.ctx, {
        type: 'task_finished', taskId: task.id,
        payload: { groupId: groupName, status: 'failed', retryable: task.status === 'todo', reportId: task.reportId,
          nextRetryAt: task.nextRetryAt, reason: 'lease_expired' },
      })
    }
    this.flushCancellations()
    this.flushCompletions()
    this.startCancellationTimer()
    this.startSettlementTimer()
    return recovered
  }

  private scheduleRetry(groupName: string, taskId: string, delayMs: number): void {
    if (this.closed) return
    const key = `${groupName}:${taskId}`
    const existing = this.retryTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      this.startScheduledRetry(groupName, taskId)
    }, Math.max(0, delayMs))
    this.retryTimers.set(key, timer)
  }

  // 到期重试必须真的交到成员手上才算数：成员还没恢复到本实例、已跨组、正忙，或定时器
  // 比 nextRetryAt 略早醒来时，旧实现会把这条重试直接丢弃，任务就永远停在 todo，只能
  // 等 reconcileManagedGroups 的兜底扫描（默认 200s）。这里改成按情况重新排下一次检查。
  private startScheduledRetry(groupName: string, taskId: string): void {
    if (this.closed) return
    let group: TeamGroup | null
    let latest: TeamTask | undefined
    try {
      group = this.store.loadGroup(groupName)
      latest = this.store.listTasks(groupName).find((item) => item.id === taskId)
    } catch (error) {
      emitRuntimeEvent(this.ctx, {
        type: 'audit',
        taskId,
        payload: { kind: 'team_retry_timer_failed', groupId: groupName, error: (error as Error).message },
      })
      console.warn(`[团队] 任务 ${taskId} 重试检查失败: ${(error as Error).message}`)
      this.scheduleRetry(groupName, taskId, RETRY_HANDOFF_MS)
      return
    }
    if (!group || !latest?.assignee || latest.status !== 'todo') return
    const due = latest.nextRetryAt ?? 0
    if (due > Date.now()) { this.scheduleRetry(groupName, taskId, Math.max(1, due - Date.now())); return }
    this.managedGroups.add(groupName)
    const member = latest.assignee
    const host = this.members.get(member)
    // 成员还没恢复到本实例（进程重启后尚未绑定）或已归到别的小组：重试仍然有效，
    // 交回下一次检查等它出现，丢弃就等于让任务停在 todo。
    if (!host || this.memberGroups.get(member) !== groupName) {
      this.scheduleRetry(groupName, taskId, RETRY_HANDOFF_MS)
      return
    }
    if (host.isBusy()) {
      this.handoffWhenIdle(groupName, taskId, member)
      return
    }
    // claimTask 与 runTask 之间没有 await：成员可用性的判断和实际领取在同一 tick，
    // 领不到时 runTask 会立刻回原因串，此时重试依然有效，交回下一次检查。
    void this.runTask(group, latest, member).then((outcome) => {
      if (typeof outcome !== 'string' || this.closed) return
      const busy = this.members.get(member)
      if (busy?.isBusy()) this.handoffWhenIdle(groupName, taskId, member)
      else this.scheduleRetry(groupName, taskId, RETRY_HANDOFF_MS)
    }, (error: unknown) => {
      emitRuntimeEvent(this.ctx, {
        type: 'audit',
        taskId,
        payload: { kind: 'team_retry_execution_failed', groupId: groupName, error: (error as Error).message },
      })
      console.warn(`[团队] 任务 ${taskId} 重试启动失败: ${(error as Error).message}`)
      if (!this.closed) this.scheduleRetry(groupName, taskId, RETRY_HANDOFF_MS)
    })
  }

  // 成员正忙时，与其 200ms 盲轮询，不如挂到它的空闲通知上——空闲那一刻立刻再交一次手。
  // 额外留一个较长的轮询作为安全网：万一成员复位时漏发通知，这条重试也不会再没人接管。
  private handoffWhenIdle(groupName: string, taskId: string, member: string): void {
    this.managedGroups.add(groupName)
    const host = this.members.get(member)
    if (!host || !host.isBusy()) {
      this.startScheduledRetry(groupName, taskId)
      return
    }
    let settled = false
    const wake = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this.handoffTimers.delete(timer)
      if (!this.closed) this.startScheduledRetry(groupName, taskId)
    }
    const timer = setTimeout(wake, RETRY_IDLE_POLL_MS)
    this.handoffTimers.add(timer)
    void host.whenIdle().then(wake, wake)
  }

  private schedulePendingRetries(groupName: string): void {
    const group = this.store.loadGroup(groupName)
    if (!group) return
    const now = Date.now()
    for (const task of this.store.listTasks(groupName)) {
      if (task.status !== 'todo' || !task.assignee || !task.nextRetryAt || task.nextRetryAt <= now) continue
      if (!this.members.has(task.assignee) || this.memberGroups.get(task.assignee) !== groupName) continue
      this.scheduleRetry(groupName, task.id, task.nextRetryAt - now)
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
    requeueOnShutdown = false,
  ): boolean {
    if ([...this.pendingCancellations.values()].some((entry) => entry.groupName === group.name && entry.taskId === task.id
      && !entry.queuedTask && entry.leaseId === leaseId && entry.memberName === memberName
      && (entry.agentId === undefined || entry.agentId === agentId))) {
      this.flushCancellations()
      this.startCancellationTimer()
      return false
    }
    let applied = false
    let cancelling = false
    let retryable = false
    let shutdownRequeue = false
    let nextRetryAt: number | undefined
    this.store.mutateTasks(group.name, (tasks) => {
      const index = tasks.findIndex((item) => item.id === task.id)
      if (index < 0) return false
      const current = tasks[index]
      if (current.status !== 'in_progress' || current.leaseId !== leaseId || current.assignee !== memberName || current.activeAgentId !== agentId) return false
      cancelling = this.captureCancellations(group.name, current)
      if (cancelling) return false
      const currentGroup = this.store.loadGroup(group.name, { strict: true })
      if (!currentGroup) throw new Error(`小组不存在，无法保存任务结果: ${group.name}`)
      shutdownRequeue = requeueOnShutdown && result.status === 'failed'
      retryable = !shutdownRequeue && result.status === 'failed' && (current.attempt ?? 0) < (current.maxAttempts ?? 1)
      nextRetryAt = retryable ? Date.now() + Math.min(30000, 1000 * 2 ** Math.max(0, (current.attempt ?? 1) - 1)) : undefined
      const protocol = retryable || shutdownRequeue ? 'RETRY' : result.status === 'done' ? 'IDLE' : 'ERR'
      tasks[index] = {
        ...current,
        status: shutdownRequeue || retryable ? 'todo' : result.status,
        attempt: shutdownRequeue ? Math.max(0, (current.attempt ?? 1) - 1) : current.attempt,
        result: result.text.slice(0, 4000),
        reportId: result.report.reportId,
        report: result.report,
        notifications: [...(current.notifications ?? []), this.taskNotification(group.name, task.id, memberName, currentGroup.lead, result.report.reportId,
          retryable || shutdownRequeue ? 'task_retry' : 'task_result', `${protocol} 任务 ${task.id}: ${result.text.split('\n')[0].slice(0, 200)}`)],
        lastError: shutdownRequeue ? '调度器关闭，任务已重新排队' : result.status === 'failed' ? result.report.error ?? result.text.slice(0, 500) : undefined,
        nextRetryAt: shutdownRequeue ? Date.now() : nextRetryAt,
        activeAgentId: undefined,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      }
      applied = true
      return true
    }, { required: true })
    if (cancelling) {
      this.flushCancellations()
      this.startCancellationTimer()
      return false
    }
    if (!applied) {
      emitRuntimeEvent(ctx, {
        type: 'audit',
        taskId: task.id,
        agentId,
        payload: { kind: 'team_stale_completion_dropped', groupId: group.name, leaseId, reportId: result.report.reportId },
      })
      return false
    }
    this.flushTaskNotifications(group.name)
    emitRuntimeEvent(ctx, {
      type: 'task_finished',
      taskId: task.id,
      agentId,
      payload: { groupId: group.name, status: shutdownRequeue ? 'todo' : result.status, retryable: retryable || shutdownRequeue, reportId: result.report.reportId, nextRetryAt },
    })
    if (retryable && nextRetryAt) this.scheduleRetry(group.name, task.id, Math.max(0, nextRetryAt - Date.now()))
    if (result.status === 'done') {
      try { this.scheduleReadyTasks(group.name) }
      catch (error) { console.warn(`[团队] 小组 ${group.name} 后续派发失败: ${(error as Error).message}`) }
    }
    return true
  }

  listReadyTasks(groupName: string): TeamTask[] {
    this.refreshSettlements(groupName)
    return readyTasks(this.readTasksWithNotifications(groupName)).filter((task) => !this.isCancelling(groupName, task))
  }

  scheduleReadyTasks(groupName: string): string[] {
    if (this.closed) return []
    this.refreshSettlements(groupName)
    const group = this.store.loadGroup(groupName)
    if (!group) return []
    const scheduled: string[] = []
    const unavailableMembers = new Set<string>()
    for (const task of this.listReadyTasks(groupName)) {
      if (!task.assignee || (task.attempt ?? 0) >= (task.maxAttempts ?? 1)) continue
      if (unavailableMembers.has(task.assignee)) continue
      const host = this.members.get(task.assignee)
      if (host?.isBusy()) {
        this.managedGroups.add(groupName)
        unavailableMembers.add(task.assignee)
        continue
      }
      const claim = this.claimTask(group, task, task.assignee)
      if (typeof claim === 'string') continue
      void this.executeClaimedTask(group, task.assignee, claim, false)
      scheduled.push(task.id)
      unavailableMembers.add(task.assignee)
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
    const normalizedTitle = parseTaskTitle(title)
    const normalizedDeps = [...new Set(parseTaskDependencies(dependsOn))]
    const normalizedMaxAttempts = parseTaskMaxAttempts(maxAttempts)
    if (assignee !== undefined && typeof assignee !== 'string') throw new Error('负责人必须是字符串')
    const group = this.store.loadGroup(groupName)
    if (!group) throw new Error(`小组不存在: ${groupName}`)
    if (assignee && (!group.members.some((member) => member.name === assignee) || this.memberGroups.get(assignee) !== groupName || !this.members.has(assignee))) {
      throw new Error(`成员 ${assignee} 不属于小组 ${groupName} 或尚未启动`)
    }
    const id = createRuntimeId('task')
    const now = Date.now()
    const task: TeamTask = {
      id,
      title: normalizedTitle,
      status: 'todo',
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      maxAttempts: normalizedMaxAttempts,
      ...(dispatchId ? { dispatchId } : {}),
      ...(normalizedDeps.length ? { depends_on: normalizedDeps } : {}),
      ...(assignee ? { assignee } : {}),
    }
    let dependencyError: string | null = null
    this.store.mutateTasks(groupName, (tasks) => {
      dependencyError = validateTaskDependencies(tasks, id, normalizedDeps)
      if (dependencyError) return false
      tasks.push(task)
      return true
    })
    if (dependencyError) throw new Error(dependencyError)
    this.managedGroups.add(groupName)
    emitRuntimeEvent(this.ctx, {
      type: 'task_created',
      taskId: task.id,
      payload: { groupId: groupName, title: normalizedTitle, assignee, dependsOn: normalizedDeps },
    })
    const signal = this.ctx.signal ? AbortSignal.any([this.ctx.signal, this.closeController.signal]) : this.closeController.signal
    void this.trackRun(resolveOnAbort(async () => {
      try {
        await this.ctx.hooks?.fire('task_created', {
          cwd: this.ctx.cwd, sessionId: this.ctx.sessionId, agentId: this.ctx.agentId,
          stats: `task=${task.id} "${normalizedTitle.slice(0, 60)}"${assignee ? ` assignee=${assignee}` : ''}`,
        }, signal)
      } catch (error) { console.warn(`[团队] 任务 ${task.id} 创建 Hook 失败: ${(error as Error).message}`) }
    }, signal, undefined))
    return task
  }
}
