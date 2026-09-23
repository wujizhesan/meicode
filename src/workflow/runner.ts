import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolRegistry, ToolContext } from '../tools/index.ts'
import type { Provider } from '../provider/types.ts'
import type { SubAgentManager } from '../subagent/manager.ts'
import type { TeamManager } from '../team/index.ts'
import type { PhaseDispatchSlot, PhaseRunRecord, WorkflowMeta, WorkflowRunRecord } from './types.ts'
import { validateWorkflowMeta } from './validate.ts'
import { projectStatePath } from '../state-paths.ts'
import { atomicWriteFile } from '../team/atomic.ts'
import { checkpointRun, claimRun, loadRun, releaseRunLease, renewRunLease } from './store.ts'

const WORKFLOW_LEASE_MS = 30000
const WORKFLOW_HEARTBEAT_MS = 10000

class WorkflowLeaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowLeaseError'
  }
}

export interface RunWorkflowOptions {
  provider: Provider
  registry: ToolRegistry
  ctx: ToolContext
  subagents: SubAgentManager
  team?: { manager: TeamManager }
  signal?: AbortSignal
  onProgress?: (msg: string) => unknown
  onCheckpoint?: (record: WorkflowRunRecord) => unknown
}

export interface WorkflowRunnerDependencies {
  renewLease?: typeof renewRunLease
  heartbeatMs?: number
}

interface PhaseExecutionResult {
  output: string
  pending: boolean
  backend: 'subagent' | 'team'
  agentId?: string
  taskId?: string
  teamGroup?: string
}

interface PhaseStart {
  backend: 'subagent' | 'team'
  agentId?: string
  taskId?: string
  teamGroup?: string
}

export function artifactsDir(cwd: string): string {
  return projectStatePath(cwd, 'workflows', 'artifacts')
}

function workflowDefinitionHash(meta: WorkflowMeta): string {
  return createHash('sha256').update(JSON.stringify(meta)).digest('hex')
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function workflowTeamGroup(cwd: string): string {
  const projectKey = safeName(cwd.split(/[\\/]/).pop() ?? 'wf').slice(0, 40) || 'wf'
  return `wf-${projectKey}`
}

function phaseKey(title: string, index: number): string {
  const direct = /^[A-Za-z0-9_-]+$/.test(title)
  const readable = safeName(title).replace(/^_+|_+$/g, '').replace(/_+/g, '_') || 'phase'
  if (direct && readable.length <= 48) return readable
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 8)
  return `${readable.slice(0, 40) || 'phase'}-${String(index + 1).padStart(2, '0')}-${hash}`
}

function reportProgress(opts: RunWorkflowOptions, message: string): void {
  try {
    const pending = opts.onProgress?.(message)
    if (pending && typeof pending === 'object' && 'then' in pending) {
      void Promise.resolve(pending).catch((error) => console.warn(`[workflow] 进度回调异常: ${(error as Error).message}`))
    }
  } catch (error) {
    console.warn(`[workflow] 进度回调异常: ${(error as Error).message}`)
  }
}

function notifyCheckpoint(opts: RunWorkflowOptions, record: WorkflowRunRecord): void {
  try {
    const pending = opts.onCheckpoint?.(structuredClone(record))
    if (pending && typeof pending === 'object' && 'then' in pending) {
      void Promise.resolve(pending).catch((error) => console.warn(`[workflow] 检查点回调异常: ${(error as Error).message}`))
    }
  } catch (error) {
    console.warn(`[workflow] 检查点回调异常: ${(error as Error).message}`)
  }
}

function checkpoint(opts: RunWorkflowOptions, record: WorkflowRunRecord, leaseId: string, releaseLease = false): void {
  checkpointRun(opts.ctx.cwd, record, leaseId, WORKFLOW_LEASE_MS, releaseLease)
  notifyCheckpoint(opts, record)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('workflow 已取消')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function cancelStartedExecution(start: PhaseStart, opts: RunWorkflowOptions): void {
  if (start.backend === 'subagent' && start.agentId) {
    opts.subagents.cancel(start.agentId, opts.ctx.sessionId)
    return
  }
  if (start.backend === 'team' && start.teamGroup && start.taskId) {
    opts.team?.manager.cancelTask(start.teamGroup, start.taskId)
  }
}

async function executeParallelPhase(
  phase: WorkflowMeta['phases'][number],
  key: string,
  rec: PhaseRunRecord,
  record: WorkflowRunRecord,
  opts: RunWorkflowOptions,
  leaseId: string,
  parentSignal: AbortSignal,
): Promise<PhaseExecutionResult[]> {
  const count = phase.agents ?? 1
  const backend = opts.team ? 'team' : 'subagent'
  if (!rec.dispatchSlots) {
    rec.dispatchSlots = Array.from({ length: count }, (_, slot) => ({
      slot,
      dispatchId: randomUUID(),
      status: 'dispatching',
      backend,
    }))
    rec.backend = backend
    if (backend === 'team') rec.teamGroup = workflowTeamGroup(opts.ctx.cwd)
    checkpoint(opts, record, leaseId)
  }
  if (rec.dispatchSlots.length !== count || rec.dispatchSlots.some((slot, index) => slot.slot !== index || slot.backend !== backend)) {
    throw new Error('workflow phase 派发槽位与当前定义不一致，无法安全恢复')
  }
  const slots = rec.dispatchSlots
  const starts = new Array<PhaseStart | undefined>(count)
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal.reason)
  parentSignal.addEventListener('abort', abortFromParent, { once: true })
  if (parentSignal.aborted) abortFromParent()
  const cancelStarted = () => {
    for (const started of starts) if (started) cancelStartedExecution(started, opts)
  }
  try {
    const executions = Array.from({ length: count }, async (_, slot) => {
      try {
        const dispatchSlot = slots[slot]
        const recovered = recoverSlotStart(dispatchSlot, rec, opts)
        if (recovered) {
          starts[slot] = recovered
          applyDispatchSlots(rec)
          checkpoint(opts, record, leaseId)
          const result = resultFromStartedExecution(recovered, opts)
          dispatchSlot.status = result.pending ? 'running' : 'settled'
          checkpoint(opts, record, leaseId)
          return result
        }
        const prompt = count > 1 ? `${phase.prompt}\n\n（phase ${phase.title} 并行任务 ${slot + 1}/${count}）` : phase.prompt
        const result = await executePhase(prompt, opts, count > 1 ? `${slot + 1}` : '', key, dispatchSlot.dispatchId, (started) => {
          starts[slot] = started
          Object.assign(dispatchSlot, started, { status: 'running' as const })
          applyDispatchSlots(rec)
          checkpoint(opts, record, leaseId)
          if (controller.signal.aborted) cancelStartedExecution(started, opts)
        }, controller.signal)
        dispatchSlot.status = result.pending ? 'running' : 'settled'
        checkpoint(opts, record, leaseId)
        return result
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error)
        cancelStarted()
        throw error
      }
    })
    const settled = await Promise.allSettled(executions)
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    return settled.map((result) => (result as PromiseFulfilledResult<PhaseExecutionResult>).value)
  } finally {
    parentSignal.removeEventListener('abort', abortFromParent)
    if (controller.signal.aborted) cancelStarted()
  }
}

function prepareRecord(meta: WorkflowMeta, sessionId?: string, existing?: WorkflowRunRecord): WorkflowRunRecord {
  const definitionHash = workflowDefinitionHash(meta)
  if (!existing) {
    return {
      runId: `wf-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      workflow: meta.name,
      ...(sessionId ? { sessionId } : {}),
      definitionHash,
      status: 'running',
      phases: meta.phases.map((phase) => ({ title: phase.title, status: 'pending' })),
      createdAt: Date.now(),
    }
  }
  if (existing.workflow !== meta.name) throw new Error(`workflow 运行记录名称不匹配: ${existing.workflow} != ${meta.name}`)
  if (existing.phases.length !== meta.phases.length || existing.phases.some((phase, index) => phase.title !== meta.phases[index]?.title)) {
    throw new Error('workflow 定义的 phase 已变化，无法安全恢复')
  }
  if (existing.definitionHash && existing.definitionHash !== definitionHash) {
    throw new Error('workflow 定义已修改，无法恢复旧运行；请重新执行')
  }
  const record = structuredClone(existing)
  record.definitionHash = definitionHash
  if (!record.sessionId && sessionId) record.sessionId = sessionId
  return record
}

function applyDispatchSlots(rec: PhaseRunRecord): void {
  const slots = rec.dispatchSlots ?? []
  rec.backend = slots[0]?.backend ?? rec.backend
  rec.agentIds = slots.flatMap((slot) => slot.agentId ? [slot.agentId] : [])
  rec.agentId = rec.agentIds[0]
  rec.taskIds = slots.flatMap((slot) => slot.taskId ? [slot.taskId] : [])
  rec.teamGroup = slots.find((slot) => slot.teamGroup)?.teamGroup ?? rec.teamGroup
}

function recoverSlotStart(slot: PhaseDispatchSlot, rec: PhaseRunRecord, opts: RunWorkflowOptions): PhaseStart | null {
  if (slot.backend === 'subagent') {
    const records = typeof opts.subagents.listRecords === 'function' ? opts.subagents.listRecords(opts.ctx.sessionId) : []
    const record = slot.agentId
      ? opts.subagents.getRecord(slot.agentId, opts.ctx.sessionId)
      : records.find((item) => item.taskId === slot.dispatchId)
    if (!record) return null
    slot.agentId = record.id
    slot.status = record.status === 'created' || record.status === 'running' ? 'running' : 'settled'
    return { backend: 'subagent', agentId: record.id }
  }
  if (!opts.team) throw new Error('缺少团队后端，无法恢复团队派发槽位')
  const teamGroup = slot.teamGroup ?? rec.teamGroup ?? workflowTeamGroup(opts.ctx.cwd)
  const task = opts.team.manager.listTasks(teamGroup).find((item) => item.id === slot.taskId || item.dispatchId === slot.dispatchId)
  if (!task) return null
  slot.taskId = task.id
  slot.teamGroup = teamGroup
  slot.agentId = task.activeAgentId ?? slot.agentId
  slot.status = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled' ? 'settled' : 'running'
  return { backend: 'team', agentId: slot.agentId, taskId: task.id, teamGroup }
}

function resultFromStartedExecution(start: PhaseStart, opts: RunWorkflowOptions): PhaseExecutionResult {
  if (start.backend === 'subagent' && start.agentId) {
    const record = opts.subagents.getRecord(start.agentId, opts.ctx.sessionId)
    if (!record || record.status === 'created' || record.status === 'running') {
      return { output: '(子 Agent 后台执行中)', pending: true, backend: 'subagent', agentId: start.agentId }
    }
    if (record.status !== 'done') throw new Error(record.error ?? `子 Agent 状态异常: ${record.status}`)
    return { output: record.result ?? '(无输出)', pending: false, backend: 'subagent', agentId: start.agentId }
  }
  if (start.backend === 'team' && start.teamGroup && start.taskId && opts.team) {
    const task = opts.team.manager.listTasks(start.teamGroup).find((item) => item.id === start.taskId)
    if (!task) throw new Error(`恢复 workflow 时找不到原团队任务: ${start.taskId}`)
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(task.lastError ?? task.result ?? `团队任务状态异常: ${task.status}`)
    }
    return {
      output: task.status === 'done' ? task.result ?? task.report?.summary ?? '(无输出)' : '(团队任务后台执行中)',
      pending: task.status !== 'done',
      backend: 'team',
      agentId: task.activeAgentId ?? start.agentId,
      taskId: task.id,
      teamGroup: start.teamGroup,
    }
  }
  throw new Error('workflow 派发槽位缺少执行标识')
}

function applyResults(rec: PhaseRunRecord, results: PhaseExecutionResult[]): void {
  rec.backend = results[0]?.backend
  rec.agentIds = results.flatMap((result) => result.agentId ? [result.agentId] : [])
  rec.agentId = rec.agentIds[0]
  rec.taskIds = results.flatMap((result) => result.taskId ? [result.taskId] : [])
  rec.teamGroup = results.find((result) => result.teamGroup)?.teamGroup
}

function writeArtifact(dir: string, phaseTitle: string, key: string, results: PhaseExecutionResult[]): string {
  const file = join(dir, `${key}.md`)
  const body = results
    .map((result, index) => `## ${phaseTitle}${results.length > 1 ? ` #${index + 1}` : ''}\n\n${result.output}`)
    .join('\n\n')
  atomicWriteFile(file, body)
  return file
}

async function reconcilePausedPhase(
  phase: WorkflowMeta['phases'][number],
  rec: PhaseRunRecord,
  opts: RunWorkflowOptions,
): Promise<PhaseExecutionResult[]> {
  const expected = phase.agents ?? 1
  if (rec.backend === 'subagent') {
    const agentIds = rec.agentIds ?? (rec.agentId ? [rec.agentId] : [])
    if (agentIds.length !== expected) throw new Error('子 Agent 启动阶段曾中断，无法确定完整执行集合')
    const records = agentIds.map((id) => opts.subagents.getRecord(id, opts.ctx.sessionId))
    if (records.some((record) => !record)) throw new Error('恢复 workflow 时找不到原子 Agent 记录')
    if (records.some((record) => record?.status === 'created' || record?.status === 'running')) {
      return agentIds.map((agentId) => ({ output: '(子 Agent 后台执行中)', pending: true, backend: 'subagent', agentId }))
    }
    const failed = records.find((record) => record?.status !== 'done')
    if (failed) throw new Error(failed.error ?? `子 Agent 状态异常: ${failed.status}`)
    return records.map((record, index) => ({
      output: record?.result ?? '(无输出)',
      pending: false,
      backend: 'subagent',
      agentId: agentIds[index],
    }))
  }
  if (rec.backend === 'team') {
    if (!opts.team || !rec.teamGroup) throw new Error('缺少团队后端，无法恢复团队 phase')
    const taskIds = rec.taskIds ?? []
    if (taskIds.length !== expected) throw new Error('团队任务启动阶段曾中断，无法确定完整执行集合')
    const tasks = opts.team.manager.listTasks(rec.teamGroup)
    const selected = taskIds.map((id) => tasks.find((task) => task.id === id))
    if (selected.some((task) => !task)) throw new Error('恢复 workflow 时找不到原团队任务')
    const failed = selected.find((task) => task?.status === 'failed' || task?.status === 'cancelled')
    if (failed) throw new Error(failed.lastError ?? failed.result ?? `团队任务失败: ${failed.id}`)
    if (selected.some((task) => task?.status !== 'done')) {
      return selected.map((task, index) => ({
        output: '(团队任务后台执行中)',
        pending: true,
        backend: 'team',
        agentId: task?.activeAgentId ?? rec.agentIds?.[index],
        taskId: taskIds[index],
        teamGroup: rec.teamGroup,
      }))
    }
    return selected.map((task, index) => ({
      output: task?.result ?? task?.report?.summary ?? '(无输出)',
      pending: false,
      backend: 'team',
      agentId: task?.activeAgentId ?? rec.agentIds?.[index],
      taskId: taskIds[index],
      teamGroup: rec.teamGroup,
    }))
  }
  throw new Error('旧运行记录缺少执行后端信息，无法恢复')
}

export async function runWorkflow(
  meta: WorkflowMeta,
  opts: RunWorkflowOptions,
  existing?: WorkflowRunRecord,
  dependencies: WorkflowRunnerDependencies = {},
): Promise<WorkflowRunRecord> {
  const issues = validateWorkflowMeta(meta)
  if (issues.length > 0) {
    throw new Error(`workflow 校验失败: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`)
  }
  let record = prepareRecord(meta, opts.ctx.sessionId, existing)
  if (record.sessionId && record.sessionId !== opts.ctx.sessionId) {
    opts = { ...opts, ctx: { ...opts.ctx, sessionId: record.sessionId } }
  }
  if (record.status === 'completed') return record
  if (existing && record.status !== 'paused' && record.status !== 'running') {
    throw new Error(`仅 paused/running 的 workflow 可以恢复，当前状态: ${record.status}`)
  }
  if (opts.signal?.aborted) throw abortError(opts.signal)
  const persistedBackend = record.backend ?? record.phases.find((phase) => phase.backend)?.backend
  const requestedBackend = opts.team ? 'team' : 'subagent'
  if (persistedBackend && persistedBackend !== requestedBackend) {
    throw new Error(`workflow ${record.runId} 需要 ${persistedBackend} 后端，当前提供的是 ${requestedBackend}`)
  }
  record.backend = persistedBackend ?? requestedBackend
  record.status = 'running'
  delete record.finishedAt
  delete record.reconcileAttempts
  delete record.lastReconcileError
  delete record.nextReconcileAt
  delete record.reconcileBlocked
  const leaseId = randomUUID()
  record = claimRun(opts.ctx.cwd, record, leaseId, WORKFLOW_LEASE_MS)
  notifyCheckpoint(opts, record)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (opts.signal?.aborted) abortFromCaller()
  const renewLease = dependencies.renewLease ?? renewRunLease
  const heartbeat = setInterval(() => {
    try {
      if (!renewLease(opts.ctx.cwd, record.runId, leaseId, WORKFLOW_LEASE_MS)) {
        controller.abort(new WorkflowLeaseError(`workflow ${record.runId} 的执行租约已失效`))
      }
    } catch (error) {
      controller.abort(new WorkflowLeaseError(`workflow ${record.runId} 续租失败: ${(error as Error).message}`))
    }
  }, Math.max(1, dependencies.heartbeatMs ?? WORKFLOW_HEARTBEAT_MS))
  heartbeat.unref()
  try {
    const dir = join(artifactsDir(opts.ctx.cwd), record.runId)
    mkdirSync(dir, { recursive: true })
    for (let index = 0; index < meta.phases.length; index++) {
      throwIfAborted(controller.signal)
      const phase = meta.phases[index]
      const rec = record.phases[index]
      if (rec.status === 'completed') continue
      const key = phaseKey(phase.title, index)
      try {
        let results: PhaseExecutionResult[]
        if (!rec.dispatchSlots && (rec.status === 'paused' || (existing && rec.status === 'running' && rec.backend))) {
          reportProgress(opts, `[workflow] phase ${phase.title}: 正在恢复`)
          results = await reconcilePausedPhase(phase, rec, opts)
        } else {
          rec.status = 'running'
          rec.startedAt = Date.now()
          delete rec.finishedAt
          delete rec.error
          checkpoint(opts, record, leaseId)
          reportProgress(opts, `[workflow] phase ${index + 1}/${meta.phases.length}: ${phase.title} (running)`)
          results = await executeParallelPhase(phase, key, rec, record, opts, leaseId, controller.signal)
        }
        throwIfAborted(controller.signal)
        applyResults(rec, results)
        rec.artifactPath = writeArtifact(dir, phase.title, key, results)
        if (results.some((result) => result.pending)) {
          rec.status = 'paused'
          rec.finishedAt = Date.now()
          record.status = 'paused'
          record.finishedAt = Date.now()
          checkpoint(opts, record, leaseId, true)
          reportProgress(opts, `[workflow] phase ${phase.title}: paused — 后台 Agent 仍在执行`)
          return record
        }
        rec.status = 'completed'
        rec.finishedAt = Date.now()
        checkpoint(opts, record, leaseId)
        reportProgress(opts, `[workflow] phase ${phase.title}: completed → ${rec.artifactPath}`)
      } catch (error) {
        const persisted = loadRun(opts.ctx.cwd, record.runId)
        if (persisted?.status === 'cancelled') {
          if (!controller.signal.aborted) controller.abort(new Error('workflow 已取消'))
          return persisted
        }
        if (controller.signal.aborted) {
          const latest = loadRun(opts.ctx.cwd, record.runId)
          if (latest?.status === 'cancelled') return latest
          if (opts.signal?.aborted) {
            rec.status = 'cancelled'
            rec.error = abortError(controller.signal).message
            rec.finishedAt = Date.now()
            record.status = 'cancelled'
            record.finishedAt = Date.now()
            checkpoint(opts, record, leaseId, true)
            reportProgress(opts, `[workflow] phase ${phase.title}: cancelled`)
            return record
          }
          throw abortError(controller.signal)
        }
        rec.status = 'failed'
        rec.error = (error as Error).message
        rec.finishedAt = Date.now()
        record.status = 'failed'
        record.finishedAt = Date.now()
        checkpoint(opts, record, leaseId, true)
        reportProgress(opts, `[workflow] phase ${phase.title}: failed — ${rec.error}`)
        return record
      }
    }
    record.status = 'completed'
    record.finishedAt = Date.now()
    checkpoint(opts, record, leaseId, true)
    reportProgress(opts, `[workflow] ${meta.name}: completed (${meta.phases.length} phases)`)
    return record
  } catch (error) {
    const latest = loadRun(opts.ctx.cwd, record.runId)
    if (latest?.status === 'cancelled') return latest
    if (error instanceof WorkflowLeaseError) {
      if (latest?.leaseId === leaseId) {
        const now = Date.now()
        record.status = 'paused'
        record.finishedAt = now
        const active = record.phases.find((phase) => phase.status === 'running')
        if (active) {
          active.status = 'paused'
          active.finishedAt = now
        }
        checkpoint(opts, record, leaseId, true)
      }
      throw error
    }
    if (latest?.leaseId === leaseId) {
      const now = Date.now()
      record.status = 'failed'
      record.finishedAt = now
      const active = record.phases.find((phase) => phase.status === 'running' || phase.status === 'paused')
      if (active) {
        active.status = 'failed'
        active.error = (error as Error).message
        active.finishedAt = now
      }
      try {
        checkpoint(opts, record, leaseId, true)
        return record
      } catch {
      }
    }
    throw error
  } finally {
    clearInterval(heartbeat)
    opts.signal?.removeEventListener('abort', abortFromCaller)
    try {
      releaseRunLease(opts.ctx.cwd, record.runId, leaseId)
    } catch {
    }
  }
}

async function executePhase(
  prompt: string,
  opts: RunWorkflowOptions,
  suffix: string,
  key: string,
  dispatchId: string,
  onStarted: (started: PhaseStart) => void,
  signal: AbortSignal,
): Promise<PhaseExecutionResult> {
  throwIfAborted(signal)
  if (opts.team) {
    const { manager } = opts.team
    const groupName = workflowTeamGroup(opts.ctx.cwd)
    const group = manager.loadGroup(groupName) ?? manager.createGroup(groupName, 'lead')
    const memberName = `wf-${key}${suffix ? `-${suffix}` : ''}`
    if (!manager.getMember(memberName, group.name)) await manager.spawnMember(group, memberName, 'general-purpose')
    const agentId = group.members.find((member) => member.name === memberName)?.agentId
    const task = manager.addTask(group.name, prompt, memberName, [], 1, dispatchId)
    onStarted({ backend: 'team', agentId, taskId: task.id, teamGroup: group.name })
    const cancel = () => manager.cancelTask(group.name, task.id)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    let output: string
    try {
      output = await manager.runTask(group, task, memberName)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
    throwIfAborted(signal)
    const current = manager.listTasks(group.name).find((item) => item.id === task.id)
    if (current?.status === 'failed' || current?.status === 'cancelled') throw new Error(current.lastError ?? current.result ?? output)
    const pending = current?.status !== 'done'
    return {
      output: pending ? `(成员后台执行中, 用 /team tasks ${groupName} 查看)\n${output}` : output,
      pending,
      backend: 'team',
      agentId,
      taskId: task.id,
      teamGroup: group.name,
    }
  }
  const spawned = await opts.subagents.spawn(
    { type: 'fork', prompt, parentHistory: [], taskId: dispatchId },
    { provider: opts.provider, registry: opts.registry, ctx: opts.ctx },
  )
  if (!spawned.id || spawned.error) throw new Error(spawned.error ?? spawned.syncResult ?? '子 Agent 启动失败')
  onStarted({ backend: 'subagent', agentId: spawned.id })
  const cancel = () => opts.subagents.cancel(spawned.id, opts.ctx.sessionId)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  if (!spawned.async) return { output: spawned.syncResult ?? '(无输出)', pending: false, backend: 'subagent', agentId: spawned.id }
  let waited: Awaited<ReturnType<SubAgentManager['waitFor']>>
  try {
    waited = await opts.subagents.waitFor(spawned.id, 120000, opts.ctx.sessionId)
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  throwIfAborted(signal)
  const subagent = waited.record
  if (waited.timedOut || subagent?.status === 'running' || !subagent) {
    return { output: '(子 Agent 后台执行中)', pending: true, backend: 'subagent', agentId: spawned.id }
  }
  if (subagent.status !== 'done') throw new Error(subagent.error ?? `子 Agent 状态异常: ${subagent.status}`)
  return { output: subagent.result ?? '(无输出)', pending: false, backend: 'subagent', agentId: spawned.id }
}

export async function validateWorkflowFile(load: () => Promise<WorkflowMeta>): Promise<string> {
  try {
    const meta = await load()
    const issues = validateWorkflowMeta(meta)
    return issues.length === 0 ? `校验通过: ${meta.name} (${meta.phases.length} phases)` : `校验失败:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`
  } catch (error) {
    return `校验失败: ${(error as Error).message}`
  }
}
