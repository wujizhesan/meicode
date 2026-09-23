import type { Provider } from '../provider/types.ts'
import type { SubAgentManager } from '../subagent/index.ts'
import type { TeamManager } from '../team/index.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import { listActiveRuns, recordReconcileFailure } from './store.ts'
import { loadWorkflow } from './loader.ts'
import { runWorkflow } from './runner.ts'
import type { PhaseRunRecord, WorkflowRunRecord } from './types.ts'

const activeReconciliations = new Set<string>()
const MAX_CONCURRENT_RECONCILIATIONS = 2

export interface WorkflowReconcileOptions {
  cwd: string
  provider: Provider
  registry: ToolRegistry
  ctx: ToolContext
  subagents: SubAgentManager
  team?: TeamManager | null
  onSettled?: (record: WorkflowRunRecord) => unknown
  onError?: (record: WorkflowRunRecord, error: Error) => unknown
  onCoordinatorError?: (error: Error) => unknown
}

export interface WorkflowReconcileDependencies {
  listActive?: typeof listActiveRuns
  load?: typeof loadWorkflow
  run?: typeof runWorkflow
  recordFailure?: typeof recordReconcileFailure
}

function phaseReady(phase: PhaseRunRecord, options: WorkflowReconcileOptions, sessionId?: string): boolean {
  if (phase.status === 'pending') return true
  if (phase.backend === 'subagent') {
    const ids = phase.agentIds ?? (phase.agentId ? [phase.agentId] : [])
    if (ids.length === 0) return true
    return ids.every((id) => {
      const status = options.subagents.getRecord(id, sessionId)?.status
      return status === undefined || (status !== 'created' && status !== 'running')
    })
  }
  if (phase.backend === 'team' && phase.teamGroup && options.team) {
    const ids = phase.taskIds ?? []
    if (ids.length === 0) return true
    const tasks = options.team.listTasks(phase.teamGroup)
    return ids.every((id) => {
      const status = tasks.find((task) => task.id === id)?.status
      return status === undefined || status === 'done' || status === 'failed' || status === 'cancelled'
    })
  }
  return false
}

function eligibleToReconcile(record: WorkflowRunRecord): boolean {
  if (record.status !== 'paused' && record.status !== 'running') return false
  if (record.reconcileBlocked || (record.nextReconcileAt ?? 0) > Date.now()) return false
  if (record.leaseId && (record.leaseExpiresAt ?? 0) > Date.now()) return false
  return true
}

function missingBackend(record: WorkflowRunRecord, options: WorkflowReconcileOptions): Error | null {
  const backend = record.backend ?? record.phases.find((phase) => phase.backend)?.backend
  return backend === 'team' && !options.team ? new Error('团队系统未启用，无法自动恢复团队 workflow') : null
}

function readyToReconcile(record: WorkflowRunRecord, options: WorkflowReconcileOptions): boolean {
  if (!eligibleToReconcile(record)) return false
  const phase = record.phases.find((item) => item.status !== 'completed')
  return phase ? phaseReady(phase, options, record.sessionId) : true
}

async function reportCoordinatorError(options: WorkflowReconcileOptions, error: Error): Promise<void> {
  try {
    await options.onCoordinatorError?.(error)
  } catch {
  }
}

export async function reconcileReadyWorkflowRuns(
  options: WorkflowReconcileOptions,
  dependencies: WorkflowReconcileDependencies = {},
): Promise<WorkflowRunRecord[]> {
  const listActive = dependencies.listActive ?? listActiveRuns
  const load = dependencies.load ?? loadWorkflow
  const run = dependencies.run ?? runWorkflow
  const recordFailure = dependencies.recordFailure ?? recordReconcileFailure
  const settled: WorkflowRunRecord[] = []
  const pending: Promise<void>[] = []
  let activeRuns: WorkflowRunRecord[]
  try {
    activeRuns = listActive(options.cwd)
  } catch (error) {
    await reportCoordinatorError(options, error as Error)
    return settled
  }
  for (const existing of activeRuns) {
    const key = `${options.cwd}\0${existing.runId}`
    let readinessError = missingBackend(existing, options)
    let ready = false
    try {
      ready = readinessError ? eligibleToReconcile(existing) : readyToReconcile(existing, options)
    } catch (error) {
      readinessError = error as Error
      ready = eligibleToReconcile(existing)
    }
    if (!ready || activeReconciliations.has(key)) continue
    if (activeReconciliations.size >= MAX_CONCURRENT_RECONCILIATIONS) break
    activeReconciliations.add(key)
    pending.push((async () => {
      try {
        if (readinessError) throw readinessError
        const meta = await load(options.cwd, existing.workflow)
        const team = options.team && (existing.backend === 'team' || existing.phases.some((phase) => phase.backend === 'team')) ? options.team : null
        const record = await run(meta, {
          provider: options.provider,
          registry: options.registry,
          ctx: existing.sessionId && existing.sessionId !== options.ctx.sessionId
            ? { ...options.ctx, sessionId: existing.sessionId }
            : options.ctx,
          subagents: options.subagents,
          ...(team ? { team: { manager: team } } : {}),
        }, existing)
        settled.push(record)
        try {
          await options.onSettled?.(structuredClone(record))
        } catch {
        }
      } catch (error) {
        let failure = existing
        try {
          failure = recordFailure(options.cwd, existing.runId, error as Error) ?? existing
        } catch (persistenceError) {
          await reportCoordinatorError(options, persistenceError as Error)
        }
        try {
          await options.onError?.(structuredClone(failure), error as Error)
        } catch {
        }
      } finally {
        activeReconciliations.delete(key)
      }
    })())
  }
  await Promise.all(pending)
  return settled
}
