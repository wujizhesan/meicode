import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamMail } from '../src/team/mail.ts'
import type { MemberHost } from '../src/team/member.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import type { TeamTaskReport } from '../src/team/types.ts'

const root = join(import.meta.dirname, 'fixtures_team_scheduler')
const repo = join(root, 'repo')
const teamRoot = join(root, 'team')
rmSync(root, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })

const store = new TeamGroupStore(teamRoot)
const mail = new TeamMail(join(teamRoot, '_shared', 'mail'))
const group = store.createGroup('scheduler', 'lead')
store.addMember(group, {
  name: 'alice',
  agentId: 'agent_alice',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
let executions = 0
const host = {
  isBusy: () => false,
  execute: async () => {
    executions++
    return {
      status: 'done' as const,
      text: 'ok',
      report: { reportId: `report_${executions}`, status: 'done' as const, summary: 'ok' },
    }
  },
} as unknown as MemberHost
const scheduler = new TeamTaskScheduler({
  store,
  mail,
  members: new Map([['alice', host]]),
  memberGroups: new Map([['alice', group.name]]),
  ctx: { cwd: repo },
})

const task = scheduler.addTask(group.name, 'scheduler task', 'alice')
const result = await scheduler.runTask(group, task, 'alice')
if (result !== 'ok' || scheduler.listTasks(group.name)[0]?.status !== 'done') throw new Error('调度器未完成任务回写')
if (!mail.read('lead').some((message) => message.taskId === task.id && message.kind === 'task_result')) throw new Error('调度器未发送完成邮件')

const manualTask = scheduler.addTask(group.name, 'manual task', 'alice')
let invalidStatusRejected = false
try {
  scheduler.updateTaskFromMember(group.name, 'alice', manualTask.id, { status: 'invalid' })
} catch (error) {
  invalidStatusRejected = (error as Error).message.includes('非法任务状态')
}
if (!invalidStatusRejected) throw new Error('成员任务更新接受了非法状态')
store.claimTask(group.name, manualTask.id, { status: 'in_progress', leaseId: 'lease_manual', leaseExpiresAt: Date.now() + 1000 })
let leasedStatusRejected = false
try {
  scheduler.updateTaskFromMember(group.name, 'alice', manualTask.id, { status: 'done' })
} catch (error) {
  leasedStatusRejected = (error as Error).message.includes('状态由调度器管理')
}
if (!leasedStatusRejected) throw new Error('成员任务更新覆盖了租约状态')

store.saveTasks(group.name, [{
  id: 'stale',
  title: 'stale task',
  status: 'in_progress',
  attempt: 1,
  maxAttempts: 2,
  leaseId: 'lease_old',
  leaseExpiresAt: 10,
}])
const recovered = scheduler.recoverStaleTasks(group.name, 20)
if (recovered[0]?.status !== 'todo' || recovered[0].nextRetryAt !== 20) throw new Error('调度器未恢复过期租约')

const fenceRoot = join(root, 'fence-team')
const fenceStore = new TeamGroupStore(fenceRoot)
const fenceMail = new TeamMail(join(fenceRoot, '_shared', 'mail'))
const fenceGroup = fenceStore.createGroup('fence', 'lead')
fenceStore.addMember(fenceGroup, {
  name: 'worker',
  agentId: 'agent_worker',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
type ExecutionResult = { status: 'done' | 'failed'; text: string; report: TeamTaskReport }
let resolveOld!: (result: ExecutionResult) => void
let resolveCurrent!: (result: ExecutionResult) => void
let fenceExecutions = 0
const fenceHost = {
  isBusy: () => false,
  execute: () => new Promise<ExecutionResult>((resolve) => {
    fenceExecutions++
    if (fenceExecutions === 1) resolveOld = resolve
    else resolveCurrent = resolve
  }),
} as unknown as MemberHost
const fenceScheduler = new TeamTaskScheduler({
  store: fenceStore,
  mail: fenceMail,
  members: new Map([['worker', fenceHost]]),
  memberGroups: new Map([['worker', fenceGroup.name]]),
  ctx: { cwd: repo },
})
const fencedTask = fenceScheduler.addTask(fenceGroup.name, 'fenced task', 'worker', [], 2)
const oldRun = fenceScheduler.runTask(fenceGroup, fencedTask, 'worker')
const oldLease = fenceStore.listTasks(fenceGroup.name)[0]?.leaseId
fenceStore.updateTask(fenceGroup.name, fencedTask.id, { leaseExpiresAt: 10 })
const staleRecovery = fenceScheduler.recoverStaleTasks(fenceGroup.name, 20)
const currentRun = fenceScheduler.runTask(fenceGroup, staleRecovery[0], 'worker')
const currentLease = fenceStore.listTasks(fenceGroup.name)[0]?.leaseId
if (!oldLease || !currentLease || oldLease === currentLease) throw new Error('任务重新领取未生成新租约')
resolveOld({ status: 'done', text: 'old result', report: { reportId: 'report_old', status: 'done', summary: 'old' } })
await oldRun
const afterOldCompletion = fenceStore.listTasks(fenceGroup.name)[0]
if (afterOldCompletion?.status !== 'in_progress' || afterOldCompletion.leaseId !== currentLease || afterOldCompletion.reportId === 'report_old') {
  throw new Error('陈旧执行结果覆盖了当前租约')
}
if (fenceMail.read('lead').some((message) => message.correlationId === 'report_old')) throw new Error('陈旧执行结果发送了完成邮件')
resolveCurrent({ status: 'done', text: 'current result', report: { reportId: 'report_current', status: 'done', summary: 'current' } })
await currentRun
const afterCurrentCompletion = fenceStore.listTasks(fenceGroup.name)[0]
if (afterCurrentCompletion?.status !== 'done' || afterCurrentCompletion.reportId !== 'report_current') throw new Error('当前租约结果未正常回写')

const foreignGroup = fenceStore.createGroup('foreign', 'lead')
fenceStore.addMember(foreignGroup, {
  name: 'worker',
  agentId: 'agent_foreign',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
let foreignAssignmentRejected = false
try {
  fenceScheduler.addTask(foreignGroup.name, 'foreign task', 'worker')
} catch (error) {
  foreignAssignmentRejected = (error as Error).message.includes('不属于小组 foreign')
}
if (!foreignAssignmentRejected || fenceStore.listTasks(foreignGroup.name).length !== 0) throw new Error('跨小组负责人任务未在创建阶段拒绝')

const heartbeatRoot = join(root, 'heartbeat-team')
const heartbeatStore = new TeamGroupStore(heartbeatRoot)
const heartbeatMail = new TeamMail(join(heartbeatRoot, '_shared', 'mail'))
const heartbeatGroup = heartbeatStore.createGroup('heartbeat', 'lead')
heartbeatStore.addMember(heartbeatGroup, {
  name: 'heartbeat-worker',
  agentId: 'agent_heartbeat',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
let finishHeartbeat!: (result: ExecutionResult) => void
const heartbeatHost = {
  isBusy: () => false,
  execute: () => new Promise<ExecutionResult>((resolve) => { finishHeartbeat = resolve }),
} as unknown as MemberHost
const heartbeatScheduler = new TeamTaskScheduler({
  store: heartbeatStore,
  mail: heartbeatMail,
  members: new Map([['heartbeat-worker', heartbeatHost]]),
  memberGroups: new Map([['heartbeat-worker', heartbeatGroup.name]]),
  ctx: { cwd: repo },
  leaseMs: 120,
  leaseHeartbeatMs: 20,
})
const heartbeatTask = heartbeatScheduler.addTask(heartbeatGroup.name, 'heartbeat task', 'heartbeat-worker')
const heartbeatRun = heartbeatScheduler.runTask(heartbeatGroup, heartbeatTask, 'heartbeat-worker')
const initialExpiry = heartbeatStore.listTasks(heartbeatGroup.name)[0]?.leaseExpiresAt ?? 0
await new Promise((resolve) => setTimeout(resolve, 70))
const renewedExpiry = heartbeatStore.listTasks(heartbeatGroup.name)[0]?.leaseExpiresAt ?? 0
if (renewedExpiry <= initialExpiry) throw new Error('运行中任务租约未续期')
if (heartbeatScheduler.recoverStaleTasks(heartbeatGroup.name, initialExpiry + 1).length !== 0) throw new Error('运行中任务被错误恢复')
finishHeartbeat({ status: 'done', text: 'heartbeat done', report: { reportId: 'report_heartbeat', status: 'done', summary: 'done' } })
await heartbeatRun

const heartbeatFaultTask = heartbeatScheduler.addTask(heartbeatGroup.name, 'heartbeat fault task', 'heartbeat-worker')
const heartbeatFaultRun = heartbeatScheduler.runTask(heartbeatGroup, heartbeatFaultTask, 'heartbeat-worker')
const originalMutateTasks = heartbeatStore.mutateTasks.bind(heartbeatStore)
let heartbeatFailureInjected = false
heartbeatStore.mutateTasks = ((groupName, mutator) => {
  if (!heartbeatFailureInjected) {
    heartbeatFailureInjected = true
    throw new Error('injected heartbeat failure')
  }
  return originalMutateTasks(groupName, mutator)
}) as TeamGroupStore['mutateTasks']
await new Promise((resolve) => setTimeout(resolve, 50))
heartbeatStore.mutateTasks = originalMutateTasks
if (!heartbeatFailureInjected) throw new Error('心跳故障注入未触发')
if (heartbeatScheduler.recoverStaleTasks(heartbeatGroup.name, Number.MAX_SAFE_INTEGER, true).length !== 0) {
  throw new Error('本进程仍持有的活动任务被过期恢复器抢占')
}
finishHeartbeat({ status: 'done', text: 'heartbeat recovered', report: { reportId: 'report_heartbeat_fault', status: 'done', summary: 'done' } })
await heartbeatFaultRun
if (heartbeatStore.listTasks(heartbeatGroup.name).find((item) => item.id === heartbeatFaultTask.id)?.status !== 'done') {
  throw new Error('心跳异常隔离后任务无法正常完成')
}

const retryRoot = join(root, 'retry-fault-team')
const retryStore = new TeamGroupStore(retryRoot)
const retryMail = new TeamMail(join(retryRoot, '_shared', 'mail'))
const retryGroup = retryStore.createGroup('retry-fault', 'lead')
retryStore.addMember(retryGroup, {
  name: 'retry-worker',
  agentId: 'agent_retry',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
let retryExecutions = 0
const retryHost = {
  isBusy: () => false,
  execute: async () => {
    retryExecutions++
    return {
      status: 'failed' as const,
      text: 'retry failure',
      report: { reportId: 'report_retry_fault', status: 'failed' as const, summary: 'failed', error: 'failed' },
    }
  },
} as unknown as MemberHost
const retryScheduler = new TeamTaskScheduler({
  store: retryStore,
  mail: retryMail,
  members: new Map([['retry-worker', retryHost]]),
  memberGroups: new Map([['retry-worker', retryGroup.name]]),
  ctx: { cwd: repo },
})
const retryTask = retryScheduler.addTask(retryGroup.name, 'retry timer fault', 'retry-worker', [], 2)
await retryScheduler.runTask(retryGroup, retryTask, 'retry-worker')
const retryFile = join(retryRoot, retryGroup.name, 'tasks.json')
const retrySnapshot = readFileSync(retryFile, 'utf8')
writeFileSync(retryFile, '{"broken":', 'utf8')
await new Promise((resolve) => setTimeout(resolve, 1100))
writeFileSync(retryFile, retrySnapshot, 'utf8')
if (retryExecutions !== 1) throw new Error('重试定时器异常后仍错误执行了任务')

const cancelRoot = join(root, 'cancel-team')
const cancelStore = new TeamGroupStore(cancelRoot)
const cancelMail = new TeamMail(join(cancelRoot, '_shared', 'mail'))
const cancelGroup = cancelStore.createGroup('cancel', 'lead')
cancelStore.addMember(cancelGroup, {
  name: 'cancel-worker',
  agentId: 'agent_cancel',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
let cancelExecutions = 0
let cancelRequests = 0
let finishCancelled!: (result: ExecutionResult) => void
const cancelHost = {
  isBusy: () => false,
  execute: () => {
    cancelExecutions++
    return new Promise<ExecutionResult>((resolve) => { finishCancelled = resolve })
  },
  cancel: () => {
    cancelRequests++
    return true
  },
} as unknown as MemberHost
const cancelScheduler = new TeamTaskScheduler({
  store: cancelStore,
  mail: cancelMail,
  members: new Map([['cancel-worker', cancelHost]]),
  memberGroups: new Map([['cancel-worker', cancelGroup.name]]),
  ctx: { cwd: repo },
})
const cancelledTask = cancelScheduler.addTask(cancelGroup.name, 'cancel task', 'cancel-worker', [], 2)
const cancelledRun = cancelScheduler.runTask(cancelGroup, cancelledTask, 'cancel-worker')
if (!cancelScheduler.cancelTask(cancelGroup.name, cancelledTask.id)) throw new Error('运行中任务取消失败')
const cancelledSnapshot = cancelStore.listTasks(cancelGroup.name).find((item) => item.id === cancelledTask.id)
if (cancelledSnapshot?.status !== 'cancelled' || cancelledSnapshot.leaseId || cancelledSnapshot.nextRetryAt) throw new Error('取消状态未原子持久化')
finishCancelled({ status: 'failed', text: '任务已取消', report: { reportId: 'report_cancel_late', status: 'failed', summary: '任务已取消' } })
await cancelledRun
await new Promise((resolve) => setTimeout(resolve, 1100))
if (cancelRequests !== 1 || cancelExecutions !== 1 || cancelStore.listTasks(cancelGroup.name)[0]?.status !== 'cancelled') {
  throw new Error('主动取消被当成失败重试或被迟到结果覆盖')
}
if (!cancelMail.read('lead').some((message) => message.taskId === cancelledTask.id && message.kind === 'task_cancelled')) {
  throw new Error('取消事件未写入团队邮箱')
}

const recoveryRoot = join(root, 'continuous-recovery-team')
const recoveryStore = new TeamGroupStore(recoveryRoot)
const recoveryMail = new TeamMail(join(recoveryRoot, '_shared', 'mail'))
const recoveryGroup = recoveryStore.createGroup('continuous-recovery', 'lead')
const recoveryScheduler = new TeamTaskScheduler({
  store: recoveryStore,
  mail: recoveryMail,
  members: new Map(),
  memberGroups: new Map(),
  ctx: { cwd: repo },
  leaseMs: 60,
  leaseHeartbeatMs: 15,
})
const staleTask = recoveryScheduler.addTask(recoveryGroup.name, 'periodic stale recovery')
recoveryScheduler.restoreGroup(recoveryGroup.name)
recoveryStore.claimTask(recoveryGroup.name, staleTask.id, {
  status: 'in_progress',
  attempt: 1,
  maxAttempts: 2,
  leaseId: 'lease-periodic',
  leaseExpiresAt: Date.now() + 20,
})
await new Promise((resolve) => setTimeout(resolve, 90))
const periodicallyRecovered = recoveryStore.listTasks(recoveryGroup.name).find((item) => item.id === staleTask.id)
if (periodicallyRecovered?.status !== 'todo' || periodicallyRecovered.leaseId) throw new Error('调度器未持续回收过期租约')

const shutdownRoot = join(root, 'shutdown-team')
const shutdownStore = new TeamGroupStore(shutdownRoot)
const shutdownMail = new TeamMail(join(shutdownRoot, '_shared', 'mail'))
const shutdownGroup = shutdownStore.createGroup('shutdown', 'lead')
shutdownStore.addMember(shutdownGroup, {
  name: 'shutdown-worker',
  agentId: 'agent_shutdown',
  role: 'worker',
  workdir: repo,
  backend: 'coroutine',
  needsApproval: false,
  status: 'idle',
})
let finishShutdown!: (result: ExecutionResult) => void
const shutdownHost = {
  isBusy: () => false,
  execute: () => new Promise<ExecutionResult>((resolve) => { finishShutdown = resolve }),
} as unknown as MemberHost
const shutdownScheduler = new TeamTaskScheduler({
  store: shutdownStore,
  mail: shutdownMail,
  members: new Map([['shutdown-worker', shutdownHost]]),
  memberGroups: new Map([['shutdown-worker', shutdownGroup.name]]),
  ctx: { cwd: repo },
})
const shutdownTask = shutdownScheduler.addTask(shutdownGroup.name, 'shutdown convergence', 'shutdown-worker', [], 2)
const shutdownRun = shutdownScheduler.runTask(shutdownGroup, shutdownTask, 'shutdown-worker')
await shutdownScheduler.close(0)
const releasedOnClose = shutdownStore.listTasks(shutdownGroup.name).find((item) => item.id === shutdownTask.id)
if (releasedOnClose?.status !== 'todo' || releasedOnClose.leaseId || releasedOnClose.attempt !== 0) {
  throw new Error('调度器关闭未主动释放活动租约')
}
finishShutdown({ status: 'done', text: 'late shutdown result', report: { reportId: 'report_shutdown_late', status: 'done', summary: 'late' } })
await shutdownRun
if (shutdownStore.listTasks(shutdownGroup.name).find((item) => item.id === shutdownTask.id)?.status !== 'todo') {
  throw new Error('关闭后的迟到结果覆盖了重新排队状态')
}

await scheduler.close()
await fenceScheduler.close()
await heartbeatScheduler.close()
await retryScheduler.close()
await cancelScheduler.close()
await recoveryScheduler.close()
if (!scheduler.isClosed()) throw new Error('调度器关闭状态错误')
if (!((await scheduler.runTask(group, recovered[0], 'alice')).includes('已关闭'))) throw new Error('关闭后的调度器仍接受任务')

rmSync(root, { recursive: true, force: true })
console.log('team_scheduler_test passed')
