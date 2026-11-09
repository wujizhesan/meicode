import type { ChatMessage, Provider } from '../provider/types.ts'
import { History } from '../session/history.ts'
import type { ToolContext, ToolRegistry, Tool } from '../tools/index.ts'
import { runAgent } from '../agent/loop.ts'
import type { AgentHandle } from '../agent/events.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { loadAgentRoles } from './loader.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import type { AgentRole, SpawnRequest, SubAgentRecord } from './types.ts'
import { isActiveSubAgentStatus } from './types.ts'
import type { SubAgentStore } from './store.ts'
import { createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'
import { randomUUID } from 'node:crypto'
import { resolveOnAbort } from '../tools/abort.ts'
import { ContextManager, spillBatch } from '../context/index.ts'
import { createSkillScope, runIsolated, SkillRunError } from '../skill/index.ts'
import type { SkillManager } from '../skill/index.ts'
import { resolve } from 'node:path'
import { disposeBrowserScope } from '../tools/browser.ts'

const SYSTEM_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'grep_code', 'load_skill', 'spawn_agent'])

const WHITESPACE = /\s/

function normalizedPrefix(parts: readonly string[], limit: number): { text: string; complete: boolean } {
  const chars: string[] = []
  let pendingSpace = false
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    if (partIndex > 0 && chars.length > 0) pendingSpace = true
    const part = parts[partIndex]
    for (let i = 0; i < part.length; i++) {
      const char = part[i]
      if (WHITESPACE.test(char)) {
        pendingSpace = chars.length > 0
        continue
      }
      if (pendingSpace) {
        if (chars.length >= limit) return { text: chars.join(''), complete: false }
        chars.push(' ')
        pendingSpace = false
      }
      if (chars.length >= limit) return { text: chars.join(''), complete: false }
      chars.push(char)
    }
  }
  return { text: chars.join(''), complete: true }
}

function normalizedSuffix(parts: readonly string[], limit: number): string {
  const reversed: string[] = []
  let length = 0
  let pendingSpace = false
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
    if (partIndex < parts.length - 1 && length > 0) pendingSpace = true
    const part = parts[partIndex]
    for (let i = part.length - 1; i >= 0; i--) {
      let char = part[i]
      const code = char.charCodeAt(0)
      if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
        const previousCode = part.charCodeAt(i - 1)
        if (previousCode >= 0xd800 && previousCode <= 0xdbff) char = `${part[--i]}${char}`
      }
      if (WHITESPACE.test(char)) {
        pendingSpace = length > 0
        continue
      }
      if (pendingSpace) {
        reversed.push(' ')
        length++
        pendingSpace = false
      }
      reversed.push(char)
      length += char.length
      if (length >= limit) return reversed.reverse().join('').slice(-limit)
    }
  }
  return reversed.reverse().join('').slice(-limit)
}

export function summarizeLocally(parts: readonly string[], limit = 500): string {
  const prefix = normalizedPrefix(parts, limit + 1)
  if (prefix.complete && prefix.text.length <= limit) return prefix.text
  const head = Math.floor(limit * 0.72)
  const tail = limit - head - 5
  return `${prefix.text.slice(0, head)} ... ${normalizedSuffix(parts, tail)}`
}

function emitRuntimeEvent(ctx: ToolContext, input: Omit<RuntimeEventInput, 'sessionId'>): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.append({ ...input, sessionId })
  } catch {
  }
}
const SYNC_MAX_WAIT = 30000 // 同步等待上限，超时转后台
const SYNC_TIMEOUT = Symbol('subagent_sync_timeout')
const SUBAGENT_LEASE_MS = 30000
const SUBAGENT_HEARTBEAT_MS = 10000
const SUBAGENT_CANCEL_POLL_MS = 500
const SUBAGENT_WAIT_POLL_MS = 250
const SUBAGENT_SAVE_ATTEMPTS = 3
const SUBAGENT_SAVE_RETRY_MS = 100
const SUBAGENT_PENDING_SAVE_MS = 500

class SubAgentPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`子 Agent 结果保存失败: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export class SubAgentManager {
  private roles = new Map<string, AgentRole>()
  private records = new Map<string, SubAgentRecord>()
  private onResult: ((record: SubAgentRecord) => unknown) | null = null
  private dirs: { builtin: string; user: string; project: string }
  private worktrees: WorktreeManager | null = null
  private store: SubAgentStore | null = null
  private currentSessionId: string | undefined
  private sessionStores = new Map<string, SubAgentStore>()
  private recordStores = new Map<string, SubAgentStore>()
  private activeAgents = new Map<string, AgentHandle>()
  private activeRuns = new Map<string, Promise<unknown>>()
  private activeControllers = new Map<string, AbortController>()
  private leaseHeartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private cancelPollers = new Map<string, ReturnType<typeof setInterval>>()
  private cancelRequests = new Set<string>()
  private pendingTerminals = new Map<string, { record: SubAgentRecord; outcome: SubAgentRecord; ownerId: string; onSaved: () => Promise<void> }>()
  private pendingSaveTimer: ReturnType<typeof setInterval> | undefined
  private readonly ownerId = randomUUID()
  private closed = false

  constructor(dirs: { builtin: string; user: string; project: string }, worktrees?: WorktreeManager | null, store?: SubAgentStore | null) {
    this.dirs = dirs
    this.worktrees = worktrees ?? null
    this.store = store ?? null
    this.currentSessionId = this.store?.getSessionId()
    if (this.store && this.currentSessionId) this.sessionStores.set(this.currentSessionId, this.store)
    const loaded = this.store?.load() ?? []
    if (this.store) this.restorePendingTerminals(this.store, loaded)
    for (const record of loaded) {
      if (this.pendingTerminals.has(record.id)) continue
      const current = isActiveSubAgentStatus(record.status)
        ? this.store?.reclaimExpired(record.id) ?? record
        : record
      this.records.set(current.id, current)
      if (this.store) this.recordStores.set(current.id, this.store)
    }
    this.flushPendingTerminals()
  }

  private startPendingSaveTimer(): void {
    if (this.closed || this.pendingSaveTimer || this.pendingTerminals.size === 0) return
    this.pendingSaveTimer = setInterval(() => this.flushPendingTerminals(), SUBAGENT_PENDING_SAVE_MS)
    this.pendingSaveTimer.unref()
  }

  private clearPendingJournal(record: SubAgentRecord, ownerId: string): void {
    try { this.storeForRecord(record)?.deletePendingTerminal(record.id, ownerId) }
    catch (error) { console.warn(`[子Agent] 补存日志清理失败: ${(error as Error).message}`) }
  }

  private stageTerminal(record: SubAgentRecord, ownerId: string): void {
    try { this.storeForRecord(record)?.savePendingTerminal(record, ownerId) }
    catch (error) { console.warn(`[子Agent] 补存日志保存失败: ${(error as Error).message}`) }
  }

  private restorePendingTerminals(store: SubAgentStore, loaded: SubAgentRecord[]): void {
    const byId = new Map(loaded.map((record) => [record.id, record]))
    for (const pending of store.loadPendingTerminals()) {
      if (this.activeRuns.has(pending.record.id) || this.pendingTerminals.has(pending.record.id)) continue
      const current = byId.get(pending.record.id)
      if (!current || !isActiveSubAgentStatus(current.status) || current.ownerId !== pending.ownerId) {
        try { store.deletePendingTerminal(pending.record.id, pending.ownerId) }
        catch (error) { console.warn(`[子Agent] 补存日志清理失败: ${(error as Error).message}`) }
        continue
      }
      const record: SubAgentRecord = { ...current, status: 'saving', result: pending.record.result, error: '结果待保存' }
      this.records.set(record.id, record)
      this.recordStores.set(record.id, store)
      this.pendingTerminals.set(record.id, { record, outcome: pending.record, ownerId: pending.ownerId, onSaved: async () => this.notifyResult(record) })
    }
    this.startPendingSaveTimer()
  }

  private resolveStore(sessionId?: string): SubAgentStore | null {
    if (!this.store) return null
    if (!sessionId) return this.store
    const cached = this.sessionStores.get(sessionId)
    if (cached) return cached
    const created = this.store.forSession(sessionId)
    this.sessionStores.set(sessionId, created)
    return created
  }

  private storeForRecord(record: SubAgentRecord): SubAgentStore | null {
    const bound = this.recordStores.get(record.id)
    if (bound) return bound
    const resolved = this.resolveStore(record.sessionId)
    if (resolved) this.recordStores.set(record.id, resolved)
    return resolved
  }

  setSession(sessionId: string): void {
    const nextStore = this.resolveStore(sessionId)
    if (!nextStore) {
      this.currentSessionId = sessionId
      return
    }
    const loaded = nextStore.load()
    this.restorePendingTerminals(nextStore, loaded)
    const nextRecords = loaded.map((record) => (
      isActiveSubAgentStatus(record.status) && !this.pendingTerminals.has(record.id)
        ? nextStore.reclaimExpired(record.id) ?? record
        : record
    ))
    for (const [id, recordStore] of this.recordStores) {
      if (recordStore === nextStore || this.activeRuns.has(id) || this.pendingTerminals.has(id)) continue
      this.records.delete(id)
      this.recordStores.delete(id)
    }
    this.store = nextStore
    this.currentSessionId = sessionId
    for (const record of nextRecords) {
      if (this.pendingTerminals.has(record.id)) continue
      this.records.set(record.id, record)
      this.recordStores.set(record.id, nextStore)
    }
  }

  getSessionId(): string | undefined {
    return this.currentSessionId
  }

  private refreshRecords(store: SubAgentStore | null = this.store): void {
    if (!store) return
    const loaded = store.load()
    this.restorePendingTerminals(store, loaded)
    for (const record of loaded) {
      if (this.activeRuns.has(record.id) || this.pendingTerminals.has(record.id)) continue
      const current = isActiveSubAgentStatus(record.status)
        ? store.reclaimExpired(record.id) ?? record
        : record
      this.records.set(current.id, current)
      this.recordStores.set(current.id, store)
    }
  }

  private persistRecord(record: SubAgentRecord, expectedOwnerId?: string): boolean {
    record.updatedAt = Date.now()
    const store = this.storeForRecord(record)
    const saved = store?.save(record, expectedOwnerId) ?? true
    if (saved) this.records.set(record.id, record)
    else this.refreshRecords(store)
    return saved
  }

  private terminalSnapshot(record: SubAgentRecord, outcome: SubAgentRecord): SubAgentRecord {
    const next = structuredClone(outcome)
    delete next.ownerId
    delete next.leaseExpiresAt
    if (this.cancelRequests.has(record.id)) {
      next.status = 'cancelled'
      next.error = record.cancelReason ?? '子 Agent 已取消'
      next.cancelRequestedAt = record.cancelRequestedAt
      next.cancelReason = record.cancelReason
    }
    return next
  }

  private acceptTerminal(record: SubAgentRecord, next: SubAgentRecord, ownerId: string = this.ownerId): void {
    Object.assign(record, next)
    delete record.ownerId
    delete record.leaseExpiresAt
    this.clearPendingJournal(record, ownerId)
    this.pendingTerminals.delete(record.id)
    this.stopLeaseHeartbeat(record.id)
    this.stopCancelPoller(record.id)
    if (this.pendingTerminals.size === 0) {
      clearInterval(this.pendingSaveTimer)
      this.pendingSaveTimer = undefined
    }
  }

  private flushPendingTerminals(): void {
    for (const [id, pending] of this.pendingTerminals) {
      if (this.activeRuns.has(id)) continue
      try {
        const next = this.terminalSnapshot(pending.record, pending.outcome)
        this.stageTerminal(next, pending.ownerId)
        if (!this.persistRecord(next, pending.ownerId)) {
          this.clearPendingJournal(pending.record, pending.ownerId)
          this.pendingTerminals.delete(id)
          this.finishRun(id)
          this.refreshRecords(this.storeForRecord(pending.record))
          continue
        }
        this.acceptTerminal(pending.record, next, pending.ownerId)
        if (this.closed) this.activeControllers.get(id)?.abort()
        const publishing = Promise.resolve().then(pending.onSaved).catch((error) => {
          console.warn(`[子Agent] 补存后通知失败: ${(error as Error).message}`)
        })
        this.activeRuns.set(id, publishing)
        void publishing.then(() => this.finishRun(id))
      } catch {
      }
    }
    if (this.pendingTerminals.size === 0) {
      clearInterval(this.pendingSaveTimer)
      this.pendingSaveTimer = undefined
    }
  }

  private async persistTerminalRecord(record: SubAgentRecord, outcome: SubAgentRecord, onSaved: () => Promise<void>): Promise<boolean> {
    for (let attempt = 0; attempt < SUBAGENT_SAVE_ATTEMPTS; attempt++) {
      const next = this.terminalSnapshot(record, outcome)
      this.stageTerminal(next, this.ownerId)
      try {
        if (!this.persistRecord(next, this.ownerId)) {
          this.clearPendingJournal(record, this.ownerId)
          this.pendingTerminals.delete(record.id)
          return false
        }
        this.acceptTerminal(record, next)
        return true
      } catch (error) {
        this.pendingTerminals.set(record.id, { record, outcome: structuredClone(outcome), ownerId: this.ownerId, onSaved })
        record.status = 'saving'
        record.result = outcome.result
        record.error = `结果待保存: ${(error as Error).message}`
        if (attempt + 1 === SUBAGENT_SAVE_ATTEMPTS || this.closed) throw new SubAgentPersistenceError(error)
        console.warn(`[子Agent] 结果保存失败，将重试: ${(error as Error).message}`)
        await new Promise<void>((done) => setTimeout(done, SUBAGENT_SAVE_RETRY_MS))
      }
    }
    return false
  }

  private startLeaseHeartbeat(record: SubAgentRecord): void {
    const store = this.storeForRecord(record)
    if (!store || !record.ownerId) return
    const ownerId = record.ownerId
    const timer = setInterval(() => {
      let renewed: SubAgentRecord | null | undefined
      try {
        renewed = store.renewLease(record.id, ownerId, Date.now() + SUBAGENT_LEASE_MS)
      } catch (error) {
        console.warn(`[子Agent] 租约续期失败: ${(error as Error).message}`)
        if ((record.leaseExpiresAt ?? 0) > Date.now() || this.pendingTerminals.has(record.id)) return
      }
      if (renewed) {
        record.leaseExpiresAt = renewed.leaseExpiresAt
        record.updatedAt = renewed.updatedAt
        if (renewed.cancelRequestedAt !== undefined) {
          record.cancelRequestedAt = renewed.cancelRequestedAt
          record.cancelReason = renewed.cancelReason
          this.cancelRequests.add(record.id)
          this.activeControllers.get(record.id)?.abort()
          this.activeAgents.get(record.id)?.cancel()
        }
        return
      }
      this.stopLeaseHeartbeat(record.id)
      if (this.pendingTerminals.has(record.id)) {
        this.flushPendingTerminals()
        return
      }
      this.cancelRequests.add(record.id)
      this.activeControllers.get(record.id)?.abort()
      this.activeAgents.get(record.id)?.cancel()
      try { this.refreshRecords(store) }
      catch (error) { console.warn(`[子Agent] 租约终止后状态读取失败: ${(error as Error).message}`) }
    }, SUBAGENT_HEARTBEAT_MS)
    timer.unref()
    this.leaseHeartbeats.set(record.id, timer)
  }

  private stopLeaseHeartbeat(id: string): void {
    const timer = this.leaseHeartbeats.get(id)
    if (timer) clearInterval(timer)
    this.leaseHeartbeats.delete(id)
  }

  private startCancelPoller(record: SubAgentRecord): void {
    const store = this.storeForRecord(record)
    if (!store || !record.ownerId) return
    const timer = setInterval(() => {
      let current: SubAgentRecord | null
      try {
        current = store.get(record.id)
      } catch (error) {
        console.warn(`[子Agent] 取消状态读取失败: ${(error as Error).message}`)
        return
      }
      if (current?.cancelRequestedAt === undefined) return
      record.cancelRequestedAt = current.cancelRequestedAt
      record.cancelReason = current.cancelReason
      this.cancelRequests.add(record.id)
      this.activeControllers.get(record.id)?.abort()
      this.activeAgents.get(record.id)?.cancel()
      this.stopCancelPoller(record.id)
    }, SUBAGENT_CANCEL_POLL_MS)
    timer.unref()
    this.cancelPollers.set(record.id, timer)
  }

  private stopCancelPoller(id: string): void {
    const timer = this.cancelPollers.get(id)
    if (timer) clearInterval(timer)
    this.cancelPollers.delete(id)
  }

  private finishRun(id: string): void {
    this.activeRuns.delete(id)
    if (this.pendingTerminals.has(id)) {
      this.startPendingSaveTimer()
      return
    }
    this.activeControllers.delete(id)
    this.cancelRequests.delete(id)
    this.stopLeaseHeartbeat(id)
    this.stopCancelPoller(id)
  }

  private notifyResult(record: SubAgentRecord): void {
    try {
      const pending = this.onResult?.(structuredClone(record))
      if (pending && typeof pending === 'object' && 'then' in pending) {
        void Promise.resolve(pending).catch((error) => console.warn(`[子Agent] 结果回调异常: ${(error as Error).message}`))
      }
    } catch (error) {
      console.warn(`[子Agent] 结果回调异常: ${(error as Error).message}`)
    }
  }

  private async markError(record: SubAgentRecord, ctx: ToolContext, req: SpawnRequest, error: unknown): Promise<void> {
    const cancelled = this.cancelRequests.has(record.id)
    const outcome: SubAgentRecord = {
      ...record,
      status: cancelled ? 'cancelled' : 'error',
      error: cancelled ? record.cancelReason ?? '子 Agent 已取消' : error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
      reportId: record.reportId ?? createRuntimeId('report'),
    }
    if (!await this.persistTerminalRecord(record, outcome, () => this.publishResult(record, ctx, req))) return
    await this.publishResult(record, ctx, req)
  }

  private async publishResult(record: SubAgentRecord, ctx: ToolContext, req: SpawnRequest): Promise<void> {
    emitRuntimeEvent(ctx, {
      type: 'subagent_finished',
      agentId: record.id,
      taskId: req.taskId,
      payload: { status: record.status, tokens: record.tokens, error: record.error },
    })
    ctx.hooks?.clearAgent(ctx.sessionId, record.id)
    try { await resolveOnAbort(async () => ctx.hooks?.fire('subagent_stop', {
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      agentId: record.id,
      targetAgentId: ctx.agentId,
      role: req.role ?? 'fork',
      stats: `status=${record.status} tokens=${record.tokens ?? 0} duration=${((Date.now() - record.startedAt) / 1000).toFixed(1)}s error=${record.error ?? ''}`,
    }, ctx.signal), ctx.signal, undefined) }
    finally { this.notifyResult(record) }
  }

  loadRoles(): void {
    this.roles.clear()
    for (const role of loadAgentRoles(this.dirs)) this.roles.set(role.name, role)
  }

  getRole(name: string): AgentRole | undefined {
    const role = this.roles.get(name)
    return role ? structuredClone(role) : undefined
  }

  listRoles(): AgentRole[] {
    return structuredClone([...this.roles.values()])
  }

  listRecords(sessionId?: string): SubAgentRecord[] {
    this.flushPendingTerminals()
    const targetStore = sessionId ? this.resolveStore(sessionId) : this.store
    this.refreshRecords(targetStore)
    return structuredClone([...this.records.entries()]
      .filter(([id, record]) => targetStore
        ? this.recordStores.get(id) === targetStore
        : !sessionId || record.sessionId === sessionId)
      .map(([, record]) => record)
      .sort((a, b) => b.startedAt - a.startedAt))
  }

  getRecord(id: string, sessionId?: string): SubAgentRecord | undefined {
    this.flushPendingTerminals()
    const targetStore = sessionId ? this.resolveStore(sessionId) : this.store
    this.refreshRecords(targetStore)
    const record = this.records.get(id)
    if (!record
      || (targetStore && this.recordStores.get(id) !== targetStore)
      || (!targetStore && sessionId && record.sessionId !== sessionId)) return undefined
    return structuredClone(record)
  }

  async waitFor(id: string, timeoutMs = 120000, sessionId?: string): Promise<{ record: SubAgentRecord | undefined; timedOut: boolean }> {
    const targetSessionId = sessionId ?? this.records.get(id)?.sessionId ?? this.currentSessionId
    const deadline = performance.now() + Math.max(0, timeoutMs)
    let record = this.getRecord(id, targetSessionId)
    if (!record) return { record, timedOut: false }
    const execution = this.activeRuns.get(id)
    if (execution) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([execution.catch(() => {}), new Promise<void>((done) => {
          timer = setTimeout(done, Math.max(0, deadline - performance.now()))
        })])
      } finally { clearTimeout(timer) }
      record = this.getRecord(id, targetSessionId)
    }
    while (record && isActiveSubAgentStatus(record.status)) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) return { record, timedOut: true }
      await new Promise<void>((done) => setTimeout(done, Math.min(SUBAGENT_WAIT_POLL_MS, remaining)))
      record = this.getRecord(id, targetSessionId)
    }
    return { record, timedOut: false }
  }

  cancel(id: string, sessionId?: string): boolean {
    const local = this.records.get(id)
    const targetStore = sessionId ? this.resolveStore(sessionId) : this.store
    const locallyOwned = local && isActiveSubAgentStatus(local.status) && local.ownerId === this.ownerId
      && (targetStore ? this.recordStores.get(id) === targetStore : !sessionId || local.sessionId === sessionId)
      && (this.activeRuns.has(id) || this.activeAgents.has(id) || this.activeControllers.has(id))
    if (locallyOwned) {
      local.cancelRequestedAt ??= Date.now()
      local.cancelReason ??= '用户取消'
      this.cancelRequests.add(id)
      this.activeControllers.get(id)?.abort()
      this.activeAgents.get(id)?.cancel()
      const pending = this.pendingTerminals.get(id)
      if (pending) this.stageTerminal(this.terminalSnapshot(local, pending.outcome), pending.ownerId)
      try { this.storeForRecord(local)?.requestCancel(id) }
      catch (error) { console.warn(`[子Agent] 取消记录待保存: ${(error as Error).message}`) }
      return true
    }
    const visible = this.getRecord(id, sessionId)
    if (!visible || !isActiveSubAgentStatus(visible.status)) return false
    const record = this.records.get(id)
    if (!record || !isActiveSubAgentStatus(record.status)) return false
    const recordStore = this.storeForRecord(record)
    if (recordStore) {
      const requested = recordStore.requestCancel(id)
      if (!requested) return false
      if (!this.pendingTerminals.has(id)) this.records.set(id, requested)
      this.recordStores.set(id, recordStore)
    }
    return recordStore !== null
  }

  setOnResult(cb: ((record: SubAgentRecord) => unknown) | null): void {
    this.onResult = cb
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true
    this.flushPendingTerminals()
    const ownedIds = [...this.activeRuns.keys()]
    for (const id of ownedIds) {
      if (this.pendingTerminals.has(id)) continue
      this.cancelRequests.add(id)
      this.activeControllers.get(id)?.abort()
      this.activeAgents.get(id)?.cancel()
      try { this.cancel(id, this.records.get(id)?.sessionId) }
      catch (error) { console.warn(`[子Agent] 关闭取消写入失败: ${(error as Error).message}`) }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.activeRuns.size > 0) {
        await Promise.race([
          Promise.allSettled([...this.activeRuns.values()]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, timeoutMs))
          }),
        ])
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.flushPendingTerminals()
      for (const id of ownedIds) {
        const record = this.records.get(id)
        if (!record || !isActiveSubAgentStatus(record.status) || record.ownerId !== this.ownerId || this.pendingTerminals.has(id)) continue
        const recordStore = this.storeForRecord(record)
        let cancelled: SubAgentRecord | null
        try {
          cancelled = recordStore
            ? recordStore.cancelOwned(id, this.ownerId)
            : { ...record, status: 'cancelled' as const, error: 'SubAgentManager 关闭，子 Agent 已取消', finishedAt: Date.now(), updatedAt: Date.now() }
        } catch (error) {
          console.warn(`[子Agent] 关闭状态写入失败: ${(error as Error).message}`)
          continue
        }
        if (!cancelled) {
          this.refreshRecords(recordStore)
          continue
        }
        delete cancelled.ownerId
        delete cancelled.leaseExpiresAt
        this.records.set(id, cancelled)
      }
      for (const heartbeat of this.leaseHeartbeats.values()) clearInterval(heartbeat)
      this.leaseHeartbeats.clear()
      for (const poller of this.cancelPollers.values()) clearInterval(poller)
      this.cancelPollers.clear()
      clearInterval(this.pendingSaveTimer)
      this.pendingSaveTimer = undefined
    }
  }

  // 工具过滤（多层防线）：白名单/父工具 → 黑名单 → spawn_agent 默认移除 → 系统工具保留
  filterTools(role: AgentRole | undefined, parentTools?: Tool[]): string[] {
    let base: string[]
    if (role?.toolsAllow?.length) {
      base = [...role.toolsAllow]
    } else if (parentTools !== undefined) {
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
    if (parentTools !== undefined) {
      const allowed = new Set(parentTools.map((tool) => tool.name))
      base = base.filter((name) => allowed.has(name))
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
  ): Promise<{ id: string; syncResult?: string; error?: string; async: boolean }> {
    if (this.closed) return { id: '', async: false, syncResult: 'SubAgentManager 已关闭', error: 'SubAgentManager 已关闭' }
    if (opts.ctx.signal?.aborted) return { id: '', async: false, syncResult: '子 Agent 启动已取消', error: '子 Agent 启动已取消' }
    req = { ...req, parentHistory: req.parentHistory ? structuredClone(req.parentHistory) : undefined, parentTools: req.parentTools ? [...req.parentTools] : undefined }
    const role = req.type === 'defined' ? this.roles.get(req.role ?? '') : undefined
    if (req.type === 'defined' && !role) {
      return { id: '', async: false, syncResult: `未找到角色: ${req.role}`, error: `未找到角色: ${req.role}` }
    }

    const id = createRuntimeId('agent')
    const controller = new AbortController()
    const executionCtx: ToolContext = { ...opts.ctx, signal: controller.signal }
    const record: SubAgentRecord = {
      id,
      role: req.role ?? 'fork',
      type: req.type,
      status: 'running',
      sessionId: executionCtx.sessionId,
      parentAgentId: req.parentAgentId ?? executionCtx.agentId,
      taskId: req.taskId,
      startedAt: Date.now(),
      ownerId: this.ownerId,
      leaseExpiresAt: Date.now() + SUBAGENT_LEASE_MS,
    }
    this.records.set(id, record)
    const recordStore = this.resolveStore(record.sessionId)
    if (recordStore) this.recordStores.set(id, recordStore)
    try { this.persistRecord(record) }
    catch (error) {
      this.records.delete(id)
      this.recordStores.delete(id)
      throw error
    }
    this.activeControllers.set(id, controller)
    const startupSignal = opts.ctx.signal
    const cancelStartup = () => {
      record.cancelReason ??= '父请求已取消'
      this.cancelRequests.add(id)
      controller.abort(startupSignal?.reason)
    }
    const detachStartup = () => startupSignal?.removeEventListener('abort', cancelStartup)
    startupSignal?.addEventListener('abort', cancelStartup, { once: true })
    if (startupSignal?.aborted) cancelStartup()
    this.startLeaseHeartbeat(record)
    this.startCancelPoller(record)
    emitRuntimeEvent(executionCtx, {
      type: 'subagent_started',
      agentId: id,
      taskId: req.taskId,
      payload: { role: req.role ?? 'fork', type: req.type },
    })
    const toolNames = this.filterTools(role, req.parentTools)
    const run = async (): Promise<string> => {
      controller.signal.throwIfAborted()
      await resolveOnAbort(async () => executionCtx.hooks?.fire('subagent_start', {
        cwd: executionCtx.cwd,
        sessionId: executionCtx.sessionId,
        agentId: id,
        role: req.role ?? 'fork',
      }, controller.signal), controller.signal, undefined)
      controller.signal.throwIfAborted()
      const toolOutputs: string[] = []
      let collecting = false
      const sub = new class extends History {
        override push(message: ChatMessage): void {
          super.push(message)
          if (collecting && message.role === 'tool') toolOutputs.push(message.content)
        }
      }()
      if (req.type === 'fork') {
        for (const m of (req.parentHistory ?? []).slice(-10)) sub.push(m)
      }
      collecting = true
      sub.push({ role: 'user', content: req.prompt })

      const maxRounds = role?.maxRounds ?? 10
      const subCtx: ToolContext = {
        ...executionCtx,
        agentId: id,
        permission: executionCtx.permission ? { ...executionCtx.permission } : undefined,
        rootLockExtra: executionCtx.rootLockExtra ? [...executionCtx.rootLockExtra] : undefined,
        ...(req.taskId ? { taskId: req.taskId } : {}),
      }
      if (role?.permission && subCtx.permission) {
        subCtx.permission.mode = role.permission
      }

      // P13：worktree 隔离——isolation: worktree 角色在独立目录执行（explicit cwd）
      let wtPath: string | null = null
      let wtBranch: string | null = null
      let worktreeName: string | null = null
      let worktreeClosed = false
      if (role?.isolation === 'worktree') {
        if (!this.worktrees) throw new Error('子Agent 要求 worktree 隔离，但当前未配置 WorktreeManager')
        try {
          const safeRole = role.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'agent'
          worktreeName = `${safeRole}-${id.replace(/[^A-Za-z0-9_-]/g, '').slice(-16)}`
          const wt = await this.worktrees.create(worktreeName)
          wtPath = wt.path
          wtBranch = wt.branch
          subCtx.cwd = wt.path // explicit cwd：所有工具调用基于 worktree 路径
        } catch (e) {
          throw new Error(`子Agent worktree 创建失败，已拒绝无隔离执行: ${(e as Error).message}`)
        }
      }

      const cleanupWorktree = async (summary?: string): Promise<string | undefined> => {
        if (worktreeClosed || !wtPath || !worktreeName || !this.worktrees) return summary
        worktreeClosed = true
        try {
          const info = await this.worktrees.exit(worktreeName)
          if (info.dirty) {
            if (summary !== undefined) return `${summary}\n（worktree 保留待合并: ${info.path}，分支 ${info.branch}）`
          } else {
            await this.worktrees.remove(worktreeName)
          }
        } catch (e) {
          console.warn(`[子Agent] worktree 收尾失败: ${(e as Error).message}`)
        } finally {
          this.worktrees.release?.(worktreeName)
        }
        return summary
      }

      let skillManager: SkillManager | undefined
      try {
        controller.signal.throwIfAborted()
        if (wtPath) {
          subCtx.rootLock = wtPath
          subCtx.rootLockExtra = [
            ...(subCtx.rootLockExtra ?? []),
            ...(role?.writePaths ?? []).map((path) => resolve(executionCtx.cwd, path)),
          ]
        }
        const scope = createSkillScope(opts.registry)
        const registry = scope.registry
        skillManager = scope.skillManager
        const budget = executionCtx.contextBudget?.()
        const contextManager = new ContextManager({
          provider: opts.provider,
          history: sub,
          cwd: subCtx.cwd,
          window: budget?.window ?? 131072,
          autoMargin: budget?.autoMargin,
          manualMargin: budget?.manualMargin,
          hooks: subCtx.hooks,
          sessionId: subCtx.sessionId,
          agentId: id,
        })
        subCtx.contextBudget = () => contextManager.snapshot()
        subCtx.setRequestOverhead = (tokens) => contextManager.setRequestOverhead(tokens)
        subCtx.beforeRequest = (mode, signal, options) => contextManager.beforeRequest(mode, signal, options)
        subCtx.afterRequest = (usage, count, overhead) => contextManager.afterRequest(usage, count, overhead)
        subCtx.spill = (results) => spillBatch(results, subCtx.cwd)
        const toolsOverride = registry
          .toOpenAITools()
          .filter((t) => toolNames.includes(t.function.name))
        const resolveRequestOptions = () => {
          const activeTools = skillManager?.activeToolNames()
          const activeNames = activeTools == null ? null : new Set([...activeTools, 'load_skill'])
          const activePrompt = skillManager?.activePrompt() ?? ''
          return {
            toolsOverride: toolsOverride.filter((tool) => !activeNames || activeNames.has(tool.function.name)),
            extraSystemMessages: activePrompt ? [activePrompt] : [],
          }
        }

        const systemPrompt = role ? role.content : buildPrompt('full')
        const systemWithCtx = wtPath
          ? `${systemPrompt}\n\n工作目录：${wtPath}（隔离 worktree，分支 ${wtBranch}）。所有文件操作都发生在该目录，不要访问外部路径。`
          : systemPrompt

        const agent = runAgent({
          provider: opts.provider,
          history: sub,
          registry,
          ctx: subCtx,
          signal: controller.signal,
          maxIterations: maxRounds,
          mode: 'full',
          systemPrompt: systemWithCtx,
          unknownToolLimit: 2,
          resolveRequestOptions,
        })
        detachStartup()
        this.activeAgents.set(id, agent)
        if (this.cancelRequests.has(id)) agent.cancel()

        const outputParts: string[] = []
        try {
          for await (const ev of agent.events) {
            if (ev.type === 'text') outputParts.push(ev.text)
          }
        } finally {
          this.activeAgents.delete(id)
        }
        const result = await agent.done
        if (result.reason === 'complete') {
          const executed = new Set<string>()
          while (!controller.signal.aborted) {
            const skill = skillManager?.takeNextIsolated()
            if (!skill) break
            if (executed.has(skill.name)) continue
            executed.add(skill.name)
            let message: string
            try {
              const summary = await runIsolated(skill, sub, {
                provider: opts.provider,
                registry,
                skillManager,
                ctx: subCtx,
                signal: controller.signal,
                systemPrompt: systemWithCtx,
                toolsOverride: resolveRequestOptions().toolsOverride,
              })
              controller.signal.throwIfAborted()
              message = `[Skill ${skill.name} 结果] ${summary}`
            } catch (error) {
              controller.signal.throwIfAborted()
              const summaryFailed = error instanceof SkillRunError && error.stage === 'summary'
              const detail = error instanceof Error ? error.message : String(error)
              const partial = error instanceof SkillRunError && error.output ? `\n部分输出：${error.output}` : ''
              message = `[Skill ${skill.name} 结果] ${summaryFailed ? '执行已完成，但摘要失败' : '执行失败'}：${detail}${partial}`
            }
            sub.push({ role: 'system', content: message })
            outputParts.push(`\n${message}`)
          }
        }
        const output = outputParts.join('')
        const summaryParts: string[] = output ? [output] : []
        if (output && toolOutputs.length > 0) summaryParts.push('---')
        for (const content of toolOutputs) summaryParts.push(content)
        if (summaryParts.length === 0) summaryParts.push(result.reason === 'complete' ? '子任务已完成' : result.errorMessage ?? `子任务已停止: ${result.reason}`)
        const summary = summarizeLocally(summaryParts)

        const status = this.cancelRequests.has(id) || result.reason === 'cancelled'
          ? 'cancelled'
          : result.reason === 'complete'
            ? 'done'
            : 'error'
        const finishedAt = Date.now()
        await disposeBrowserScope(subCtx)
        const finalSummary = await cleanupWorktree(summary) ?? summary
        const outcome: SubAgentRecord = {
          ...record,
          status,
          finishedAt,
          tokens: result.totalTokens,
          reportId: createRuntimeId('report'),
          result: finalSummary,
          evidence: result.evidence,
          error: status === 'cancelled' ? record.cancelReason ?? result.errorMessage ?? '子 Agent 已取消'
            : status === 'error' ? result.errorMessage ?? result.reason : undefined,
        }
        if (!await this.persistTerminalRecord(record, outcome, () => this.publishResult(record, executionCtx, req))) return finalSummary
        await this.publishResult(record, executionCtx, req)
        return finalSummary
      } catch (error) {
        await disposeBrowserScope(subCtx)
        await cleanupWorktree()
        throw error
      } finally {
        skillManager?.clear()
      }
    }

    const execution = Promise.resolve().then(run).catch(async (e) => {
      if (e instanceof SubAgentPersistenceError) console.warn(`[子Agent] ${e.message}`)
      else await this.markError(record, executionCtx, req, e)
      throw e
    })
    this.activeRuns.set(id, execution)
    void execution.then(
      () => { detachStartup(); this.finishRun(id) },
      () => { detachStartup(); this.finishRun(id) },
    )
    if (req.async || req.type === 'fork') return { id, async: true }

    let timeout: ReturnType<typeof setTimeout> | undefined
    let syncResult: string | typeof SYNC_TIMEOUT
    try {
      syncResult = await Promise.race([
        execution,
        new Promise<typeof SYNC_TIMEOUT>((resolve) => {
          timeout = setTimeout(() => {
            resolve(SYNC_TIMEOUT)
          }, SYNC_MAX_WAIT)
        }),
      ])
    } catch (error) {
      if (error instanceof SubAgentPersistenceError && this.pendingTerminals.has(id)) return { id, async: true }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (syncResult === SYNC_TIMEOUT) {
      return { id, async: true }
    }
    return {
      id,
      syncResult,
      async: false,
      ...(record.status === 'done' ? {} : { error: record.error ?? `子 Agent 已停止: ${record.status}` }),
    }
  }
}
