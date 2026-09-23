import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PhaseDispatchSlot, PhaseRunRecord, WorkflowRunRecord } from './types.ts'
import { projectStatePath } from '../state-paths.ts'
import { atomicWriteFile } from '../team/atomic.ts'
import { withLock } from '../team/lock.ts'

interface CachedWorkflowRun {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  record: WorkflowRunRecord
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ACTIVE_INDEX_NAME = 'active-runs.index'
const RECONCILE_MAX_ATTEMPTS = 5
const RECONCILE_BASE_DELAY_MS = 5000
const RECONCILE_MAX_DELAY_MS = 5 * 60 * 1000
const RUN_STATUSES = new Set<WorkflowRunRecord['status']>(['running', 'completed', 'failed', 'paused', 'cancelled'])
const PHASE_STATUSES = new Set<PhaseRunRecord['status']>(['pending', 'running', 'completed', 'failed', 'paused', 'cancelled'])
const workflowRunCache = new Map<string, CachedWorkflowRun>()

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function optionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isDispatchSlot(value: unknown): value is PhaseDispatchSlot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const slot = value as Record<string, unknown>
  const valid = Number.isSafeInteger(slot.slot)
    && (slot.slot as number) >= 0
    && typeof slot.dispatchId === 'string'
    && slot.dispatchId.length > 0
    && (slot.status === 'dispatching' || slot.status === 'running' || slot.status === 'settled')
    && (slot.backend === 'subagent' || slot.backend === 'team')
    && optionalString(slot.agentId)
    && optionalString(slot.taskId)
    && optionalString(slot.teamGroup)
  if (!valid) return false
  if (slot.status !== 'dispatching' && slot.backend === 'subagent' && typeof slot.agentId !== 'string') return false
  if (slot.status !== 'dispatching' && slot.backend === 'team' && (typeof slot.taskId !== 'string' || typeof slot.teamGroup !== 'string')) return false
  return true
}

function isPhaseRecord(value: unknown): value is PhaseRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const phase = value as Record<string, unknown>
  if (typeof phase.title !== 'string' || !phase.title) return false
  if (typeof phase.status !== 'string' || !PHASE_STATUSES.has(phase.status as PhaseRunRecord['status'])) return false
  if (phase.backend !== undefined && phase.backend !== 'subagent' && phase.backend !== 'team') return false
  for (const key of ['agentId', 'teamGroup', 'artifactPath', 'error'] as const) {
    if (!optionalString(phase[key])) return false
  }
  if (phase.agentIds !== undefined && !stringArray(phase.agentIds)) return false
  if (phase.taskIds !== undefined && !stringArray(phase.taskIds)) return false
  if (phase.dispatchSlots !== undefined) {
    if (!Array.isArray(phase.dispatchSlots) || !phase.dispatchSlots.every(isDispatchSlot)) return false
    const slots = phase.dispatchSlots as PhaseDispatchSlot[]
    if (new Set(slots.map((slot) => slot.slot)).size !== slots.length) return false
    if (new Set(slots.map((slot) => slot.dispatchId)).size !== slots.length) return false
  }
  return optionalTimestamp(phase.startedAt) && optionalTimestamp(phase.finishedAt)
}

export function isWorkflowRunRecord(value: unknown): value is WorkflowRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.runId !== 'string' || !RUN_ID_RE.test(record.runId)) return false
  if (typeof record.workflow !== 'string' || !record.workflow) return false
  if (!optionalString(record.sessionId)) return false
  if (record.backend !== undefined && record.backend !== 'subagent' && record.backend !== 'team') return false
  if (typeof record.status !== 'string' || !RUN_STATUSES.has(record.status as WorkflowRunRecord['status'])) return false
  if (!Array.isArray(record.phases) || !record.phases.every(isPhaseRecord)) return false
  if (record.definitionHash !== undefined && typeof record.definitionHash !== 'string') return false
  if (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0)) return false
  if (record.reconcileAttempts !== undefined && (!Number.isSafeInteger(record.reconcileAttempts) || (record.reconcileAttempts as number) < 0)) return false
  if (!optionalString(record.lastReconcileError)) return false
  if (record.reconcileBlocked !== undefined && typeof record.reconcileBlocked !== 'boolean') return false
  if (!optionalString(record.leaseId)) return false
  if ((record.leaseId === undefined) !== (record.leaseExpiresAt === undefined)) return false
  return typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && record.createdAt >= 0
    && optionalTimestamp(record.updatedAt)
    && optionalTimestamp(record.finishedAt)
    && optionalTimestamp(record.leaseExpiresAt)
    && optionalTimestamp(record.nextReconcileAt)
}

function cloneWorkflowRun(record: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...record,
    phases: record.phases.map((phase) => ({
      ...phase,
      agentIds: phase.agentIds ? [...phase.agentIds] : undefined,
      taskIds: phase.taskIds ? [...phase.taskIds] : undefined,
      dispatchSlots: phase.dispatchSlots?.map((slot) => ({ ...slot })),
    })),
  }
}

function runFile(cwd: string, runId: string): string | null {
  if (!RUN_ID_RE.test(runId)) return null
  return join(runsDir(cwd), `${runId}.json`)
}

function quarantine(file: string): void {
  workflowRunCache.delete(file)
  try {
    renameSync(file, `${file}.corrupt.${Date.now()}`)
  } catch {
  }
}

function readCachedRun(file: string): WorkflowRunRecord | null {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(file)
  } catch {
    workflowRunCache.delete(file)
    return null
  }
  const cached = workflowRunCache.get(file)
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
    return cached.record
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isWorkflowRunRecord(parsed)) throw new Error('invalid workflow run')
    workflowRunCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, record: parsed })
    return parsed
  } catch {
    quarantine(file)
    return null
  }
}

function readRunForUpdate(file: string): WorkflowRunRecord | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isWorkflowRunRecord(parsed)) throw new Error('invalid workflow run')
    return parsed
  } catch (error) {
    throw new Error(`workflow 运行记录损坏，已拒绝覆盖: ${file}（${(error as Error).message}）`)
  }
}

function revisionOf(record: WorkflowRunRecord | null): number {
  return record?.revision ?? 0
}

function isActiveRun(record: WorkflowRunRecord): boolean {
  return record.status === 'running' || record.status === 'paused'
}

function activeIndexFile(cwd: string): string {
  return join(runsDir(cwd), ACTIVE_INDEX_NAME)
}

function scanActiveRunIds(cwd: string): string[] {
  const dir = runsDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json') && RUN_ID_RE.test(file.slice(0, -'.json'.length)))
    .map((file) => readCachedRun(join(dir, file)))
    .filter((record): record is WorkflowRunRecord => record !== null && isActiveRun(record))
    .map((record) => record.runId)
}

function readActiveRunIds(cwd: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(activeIndexFile(cwd), 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' && RUN_ID_RE.test(id))) return null
    return [...new Set(parsed)]
  } catch {
    return null
  }
}

function mutateActiveIndex(cwd: string, record?: WorkflowRunRecord, rebuild = false): void {
  const file = activeIndexFile(cwd)
  withLock(`${file}.lock`, () => {
    const ids = new Set(rebuild ? scanActiveRunIds(cwd) : readActiveRunIds(cwd) ?? scanActiveRunIds(cwd))
    if (record) {
      if (isActiveRun(record)) ids.add(record.runId)
      else ids.delete(record.runId)
    }
    atomicWriteFile(file, JSON.stringify([...ids].sort()))
  })
}

function writeRun(cwd: string, file: string, record: WorkflowRunRecord): WorkflowRunRecord {
  if (isActiveRun(record)) {
    const indexFile = activeIndexFile(cwd)
    withLock(`${indexFile}.lock`, () => {
      const ids = new Set(readActiveRunIds(cwd) ?? scanActiveRunIds(cwd))
      ids.add(record.runId)
      atomicWriteFile(indexFile, JSON.stringify([...ids].sort()))
      atomicWriteFile(file, JSON.stringify(record, null, 2))
    })
  } else {
    atomicWriteFile(file, JSON.stringify(record, null, 2))
    mutateActiveIndex(cwd, record)
  }
  workflowRunCache.delete(file)
  return cloneWorkflowRun(record)
}

function syncRun(target: WorkflowRunRecord, source: WorkflowRunRecord): void {
  target.revision = source.revision
  target.updatedAt = source.updatedAt
  if (source.leaseId === undefined) delete target.leaseId
  else target.leaseId = source.leaseId
  if (source.leaseExpiresAt === undefined) delete target.leaseExpiresAt
  else target.leaseExpiresAt = source.leaseExpiresAt
}

export function runsDir(cwd: string): string {
  return projectStatePath(cwd, 'workflows', 'runs')
}

export function saveRun(cwd: string, record: WorkflowRunRecord): WorkflowRunRecord {
  if (!isWorkflowRunRecord(record)) throw new Error('非法 workflow 运行记录')
  const file = runFile(cwd, record.runId)
  if (!file) throw new Error(`非法 workflow runId: ${record.runId}`)
  let saved!: WorkflowRunRecord
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (record.leaseId && current?.leaseId !== record.leaseId) throw new Error(`workflow ${record.runId} 不能通过普通保存建立执行租约`)
    if (current?.leaseId && (current.leaseExpiresAt ?? 0) > Date.now() && current.leaseId !== record.leaseId) {
      throw new Error(`workflow ${record.runId} 正由其他执行者持有`)
    }
    if (revisionOf(current) !== (record.revision ?? 0)) {
      throw new Error(`workflow ${record.runId} 已被其他执行者更新`)
    }
    const next = structuredClone(record)
    next.revision = revisionOf(current) + 1
    next.updatedAt = Date.now()
    saved = writeRun(cwd, file, next)
  })
  syncRun(record, saved)
  return cloneWorkflowRun(saved)
}

export function claimRun(cwd: string, record: WorkflowRunRecord, leaseId: string, leaseMs: number): WorkflowRunRecord {
  if (!isWorkflowRunRecord(record) || !leaseId) throw new Error('非法 workflow 租约请求')
  const file = runFile(cwd, record.runId)
  if (!file) throw new Error(`非法 workflow runId: ${record.runId}`)
  let claimed!: WorkflowRunRecord
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (revisionOf(current) !== (record.revision ?? 0)) {
      throw new Error(`workflow ${record.runId} 已被其他执行者更新，请重新加载`)
    }
    if (current?.leaseId && current.leaseId !== leaseId && (current.leaseExpiresAt ?? 0) > Date.now()) {
      throw new Error(`workflow ${record.runId} 正由其他执行者持有`)
    }
    const next = structuredClone(record)
    next.revision = revisionOf(current) + 1
    next.updatedAt = Date.now()
    next.leaseId = leaseId
    next.leaseExpiresAt = Date.now() + Math.max(1000, leaseMs)
    claimed = writeRun(cwd, file, next)
  })
  return claimed
}

export function checkpointRun(
  cwd: string,
  record: WorkflowRunRecord,
  leaseId: string,
  leaseMs: number,
  releaseLease = false,
): WorkflowRunRecord {
  if (!isWorkflowRunRecord(record)) throw new Error('非法 workflow 运行记录')
  const file = runFile(cwd, record.runId)
  if (!file) throw new Error(`非法 workflow runId: ${record.runId}`)
  let saved!: WorkflowRunRecord
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (!current || current.leaseId !== leaseId) throw new Error(`workflow ${record.runId} 的执行租约已失效`)
    if (revisionOf(current) !== (record.revision ?? 0)) throw new Error(`workflow ${record.runId} 已被其他执行者更新`)
    const next = structuredClone(record)
    next.revision = revisionOf(current) + 1
    next.updatedAt = Date.now()
    if (releaseLease) {
      delete next.leaseId
      delete next.leaseExpiresAt
    } else {
      next.leaseId = leaseId
      next.leaseExpiresAt = Date.now() + Math.max(1000, leaseMs)
    }
    saved = writeRun(cwd, file, next)
  })
  syncRun(record, saved)
  return cloneWorkflowRun(saved)
}

export function renewRunLease(cwd: string, runId: string, leaseId: string, leaseMs: number): boolean {
  const file = runFile(cwd, runId)
  if (!file) return false
  let renewed = false
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (!current || current.leaseId !== leaseId || current.status !== 'running') return
    current.leaseExpiresAt = Date.now() + Math.max(1000, leaseMs)
    current.updatedAt = Date.now()
    writeRun(cwd, file, current)
    renewed = true
  })
  return renewed
}

export function releaseRunLease(cwd: string, runId: string, leaseId: string): void {
  const file = runFile(cwd, runId)
  if (!file) return
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (!current || current.leaseId !== leaseId) return
    delete current.leaseId
    delete current.leaseExpiresAt
    current.updatedAt = Date.now()
    current.revision = revisionOf(current) + 1
    writeRun(cwd, file, current)
  })
}

export function cancelRun(cwd: string, runId: string): WorkflowRunRecord | null {
  const file = runFile(cwd, runId)
  if (!file) return null
  let cancelled: WorkflowRunRecord | null = null
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (!current) return
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      cancelled = cloneWorkflowRun(current)
      return
    }
    const now = Date.now()
    current.status = 'cancelled'
    current.finishedAt = now
    current.updatedAt = now
    current.revision = revisionOf(current) + 1
    delete current.leaseId
    delete current.leaseExpiresAt
    const active = current.phases.find((phase) => phase.status === 'running' || phase.status === 'paused')
    if (active) {
      active.status = 'cancelled'
      active.finishedAt = now
      active.error = '用户取消'
    }
    cancelled = writeRun(cwd, file, current)
  })
  return cancelled ? cloneWorkflowRun(cancelled) : null
}

export function loadRun(cwd: string, runId: string): WorkflowRunRecord | null {
  const file = runFile(cwd, runId)
  if (!file || !existsSync(file)) return null
  const record = readCachedRun(file)
  return record ? cloneWorkflowRun(record) : null
}

export function listRuns(cwd: string, limit = 20): WorkflowRunRecord[] {
  const dir = runsDir(cwd)
  if (!existsSync(dir)) return []
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json') && RUN_ID_RE.test(file.slice(0, -'.json'.length)))
    .map((file) => readCachedRun(join(dir, file)))
    .filter((record): record is WorkflowRunRecord => record !== null)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, boundedLimit)
    .map(cloneWorkflowRun)
}

export function listActiveRuns(cwd: string): WorkflowRunRecord[] {
  let ids = readActiveRunIds(cwd)
  if (!ids) {
    mutateActiveIndex(cwd)
    ids = readActiveRunIds(cwd) ?? []
  }
  const records = ids
    .map((runId) => loadRun(cwd, runId))
    .filter((record): record is WorkflowRunRecord => record !== null && isActiveRun(record))
    .sort((left, right) => left.createdAt - right.createdAt)
  if (records.length !== ids.length) mutateActiveIndex(cwd, undefined, true)
  return records
}

export function recordReconcileFailure(cwd: string, runId: string, error: Error, now = Date.now()): WorkflowRunRecord | null {
  const file = runFile(cwd, runId)
  if (!file) return null
  let updated: WorkflowRunRecord | null = null
  withLock(`${file}.lock`, () => {
    const current = readRunForUpdate(file)
    if (!current || !isActiveRun(current)) return
    if (current.leaseId && (current.leaseExpiresAt ?? 0) > now) return
    const attempts = (current.reconcileAttempts ?? 0) + 1
    current.reconcileAttempts = attempts
    current.lastReconcileError = error.message.slice(0, 2000)
    current.reconcileBlocked = attempts >= RECONCILE_MAX_ATTEMPTS
    if (current.reconcileBlocked) delete current.nextReconcileAt
    else current.nextReconcileAt = now + Math.min(RECONCILE_MAX_DELAY_MS, RECONCILE_BASE_DELAY_MS * 2 ** (attempts - 1))
    current.updatedAt = now
    current.revision = revisionOf(current) + 1
    updated = writeRun(cwd, file, current)
  })
  return updated ? cloneWorkflowRun(updated) : null
}
