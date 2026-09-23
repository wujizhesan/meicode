import type { Provider } from '../provider/types.ts'
import { History } from '../session/history.ts'
import type { ToolContext, ToolRegistry, Tool } from '../tools/index.ts'
import { runAgent } from '../agent/loop.ts'
import type { AgentHandle } from '../agent/events.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import { loadAgentRoles } from './loader.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import type { AgentRole, SpawnRequest, SubAgentRecord } from './types.ts'
import type { SubAgentStore } from './store.ts'
import { createRuntimeId } from '../runtime/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'
import { randomUUID } from 'node:crypto'

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
  private leaseHeartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private cancelPollers = new Map<string, ReturnType<typeof setInterval>>()
  private cancelRequests = new Set<string>()
  private readonly ownerId = randomUUID()
  private closed = false

  constructor(dirs: { builtin: string; user: string; project: string }, worktrees?: WorktreeManager | null, store?: SubAgentStore | null) {
    this.dirs = dirs
    this.worktrees = worktrees ?? null
    this.store = store ?? null
    this.currentSessionId = this.store?.getSessionId()
    if (this.store && this.currentSessionId) this.sessionStores.set(this.currentSessionId, this.store)
    for (const record of this.store?.load() ?? []) {
      const current = record.status === 'created' || record.status === 'running'
        ? this.store?.reclaimExpired(record.id) ?? record
        : record
      this.records.set(current.id, current)
      if (this.store) this.recordStores.set(current.id, this.store)
    }
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
    const nextRecords = nextStore.load().map((record) => (
      record.status === 'created' || record.status === 'running'
        ? nextStore.reclaimExpired(record.id) ?? record
        : record
    ))
    for (const [id, recordStore] of this.recordStores) {
      if (recordStore === nextStore || this.activeRuns.has(id)) continue
      this.records.delete(id)
      this.recordStores.delete(id)
    }
    this.store = nextStore
    this.currentSessionId = sessionId
    for (const record of nextRecords) {
      this.records.set(record.id, record)
      this.recordStores.set(record.id, nextStore)
    }
  }

  getSessionId(): string | undefined {
    return this.currentSessionId
  }

  private refreshRecords(store: SubAgentStore | null = this.store): void {
    if (!store) return
    for (const record of store.load()) {
      if (this.activeRuns.has(record.id)) continue
      const current = record.status === 'created' || record.status === 'running'
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
      }
      if (renewed) {
        record.leaseExpiresAt = renewed.leaseExpiresAt
        record.updatedAt = renewed.updatedAt
        record.cancelRequestedAt = renewed.cancelRequestedAt
        record.cancelReason = renewed.cancelReason
        if (renewed.cancelRequestedAt !== undefined) {
          this.cancelRequests.add(record.id)
          this.activeAgents.get(record.id)?.cancel()
        }
        return
      }
      this.stopLeaseHeartbeat(record.id)
      this.cancelRequests.add(record.id)
      this.activeAgents.get(record.id)?.cancel()
      this.refreshRecords(store)
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
    const ownerId = record.ownerId
    const cancelled = this.cancelRequests.has(record.id)
    record.status = cancelled ? 'cancelled' : 'error'
    record.error = cancelled ? record.cancelReason ?? '子 Agent 已取消' : error instanceof Error ? error.message : String(error)
    record.finishedAt = Date.now()
    delete record.ownerId
    delete record.leaseExpiresAt
    if (!this.persistRecord(record, ownerId)) return
    emitRuntimeEvent(ctx, {
      type: 'subagent_finished',
      agentId: record.id,
      taskId: req.taskId,
      payload: { status: record.status, error: record.error },
    })
    ctx.hooks?.clearAgent(ctx.sessionId, record.id)
    await ctx.hooks?.fire('subagent_stop', {
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      agentId: record.id,
      targetAgentId: ctx.agentId,
      role: req.role ?? 'fork',
      stats: `status=${record.status} error=${record.error ?? ''}`,
    })
    this.notifyResult(record)
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
    const targetStore = sessionId ? this.resolveStore(sessionId) : this.store
    this.refreshRecords(targetStore)
    const record = this.records.get(id)
    if (!record
      || (targetStore && this.recordStores.get(id) !== targetStore)
      || (!targetStore && sessionId && record.sessionId !== sessionId)) return undefined
    return structuredClone(record)
  }

  async waitFor(id: string, timeoutMs = 120000, sessionId?: string): Promise<{ record: SubAgentRecord | undefined; timedOut: boolean }> {
    const execution = this.activeRuns.get(id)
    if (!execution) return { record: this.getRecord(id, sessionId), timedOut: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      execution.then(() => false, () => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs))
      }),
    ])
    if (timer) clearTimeout(timer)
    return { record: this.getRecord(id, sessionId), timedOut }
  }

  cancel(id: string, sessionId?: string): boolean {
    const visible = this.getRecord(id, sessionId)
    if (!visible || (visible.status !== 'created' && visible.status !== 'running')) return false
    const record = this.records.get(id)
    if (!record || (record.status !== 'created' && record.status !== 'running')) return false
    const recordStore = this.storeForRecord(record)
    if (recordStore) {
      const requested = recordStore.requestCancel(id)
      if (!requested) return false
      this.records.set(id, requested)
      this.recordStores.set(id, recordStore)
    }
    const locallyOwned = record.ownerId === this.ownerId && (this.activeRuns.has(id) || this.activeAgents.has(id))
    if (locallyOwned) {
      record.cancelRequestedAt ??= Date.now()
      record.cancelReason ??= '用户取消'
      this.cancelRequests.add(id)
      this.activeAgents.get(id)?.cancel()
    }
    return recordStore !== null || locallyOwned
  }

  setOnResult(cb: ((record: SubAgentRecord) => unknown) | null): void {
    this.onResult = cb
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true
    const ownedIds = [...this.activeRuns.keys()]
    for (const id of ownedIds) this.cancel(id, this.records.get(id)?.sessionId)
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
      for (const id of ownedIds) {
        const record = this.records.get(id)
        if (!record || (record.status !== 'created' && record.status !== 'running') || record.ownerId !== this.ownerId) continue
        const recordStore = this.storeForRecord(record)
        const cancelled = recordStore
          ? recordStore.cancelOwned(id, this.ownerId)
          : { ...record, status: 'cancelled' as const, error: 'SubAgentManager 关闭，子 Agent 已取消', finishedAt: Date.now(), updatedAt: Date.now() }
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
    }
  }

  // 工具过滤（多层防线）：白名单/父工具 → 黑名单 → spawn_agent 默认移除 → 系统工具保留
  filterTools(role: AgentRole | undefined, parentTools?: Tool[]): string[] {
    let base: string[]
    if (role?.toolsAllow?.length) {
      base = [...role.toolsAllow]
    } else if (parentTools?.length) {
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
    const role = req.type === 'defined' ? this.roles.get(req.role ?? '') : undefined
    if (req.type === 'defined' && !role) {
      return { id: '', async: false, syncResult: `未找到角色: ${req.role}`, error: `未找到角色: ${req.role}` }
    }

    const id = createRuntimeId('agent')
    const executionCtx: ToolContext = { ...opts.ctx }
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
    this.persistRecord(record)
    this.startLeaseHeartbeat(record)
    this.startCancelPoller(record)
    emitRuntimeEvent(executionCtx, {
      type: 'subagent_started',
      agentId: id,
      taskId: req.taskId,
      payload: { role: req.role ?? 'fork', type: req.type },
    })
    // subagent_start hook：子任务启动通知（审计/监控）
    await executionCtx.hooks?.fire('subagent_start', {
      cwd: executionCtx.cwd,
      sessionId: executionCtx.sessionId,
      agentId: id,
      role: req.role ?? 'fork',
    })

    const toolNames = this.filterTools(role, req.parentTools)
    const run = async (): Promise<string> => {
      const sub = new History()
      if (req.type === 'fork') {
        for (const m of (req.parentHistory ?? []).slice(-10)) sub.push(m)
      }
      sub.push({ role: 'user', content: req.prompt })

      const maxRounds = role?.maxRounds ?? 10
      const subCtx: ToolContext = { ...executionCtx, agentId: id, ...(req.taskId ? { taskId: req.taskId } : {}) }
      if (role?.permission && subCtx.permission) {
        subCtx.permission = { ...subCtx.permission, mode: role.permission }
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

      try {
      const toolsOverride = opts.registry
        .toOpenAITools()
        .filter((t) => toolNames.includes(t.function.name))

      const systemPrompt = role ? role.content : buildPrompt('full')
      const systemWithCtx = wtPath
        ? `${systemPrompt}\n\n工作目录：${wtPath}（隔离 worktree，分支 ${wtBranch}）。所有文件操作都发生在该目录，不要访问外部路径。`
        : systemPrompt

      const agent = runAgent({
        provider: opts.provider,
        history: sub,
        registry: opts.registry,
        ctx: subCtx,
        maxIterations: maxRounds,
        mode: 'full',
        systemPrompt: systemWithCtx,
        unknownToolLimit: 2,
        toolsOverride,
      })
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
      const output = outputParts.join('')
      const result = await agent.done
      const summaryParts: string[] = output ? [output] : []
      let hasToolOutput = false
      for (const message of sub.view()) {
        if (message.role !== 'tool') continue
        if (!hasToolOutput && output) summaryParts.push('---')
        summaryParts.push(message.content)
        hasToolOutput = true
      }
      if (summaryParts.length === 0) summaryParts.push('子任务已完成')
      const summary = summarizeLocally(summaryParts)

      const ownerId = record.ownerId
      record.status = this.cancelRequests.has(id) || result.reason === 'cancelled'
        ? 'cancelled'
        : result.reason === 'complete'
          ? 'done'
          : 'error'
      record.finishedAt = Date.now()
      record.tokens = result.totalTokens
      record.reportId = createRuntimeId('report')
      const finalSummary = await cleanupWorktree(summary) ?? summary
      record.result = finalSummary
      record.evidence = result.evidence
      if (record.status === 'cancelled') record.error = record.cancelReason ?? result.errorMessage ?? '子 Agent 已取消'
      else if (record.status === 'error') record.error = result.errorMessage ?? result.reason
      delete record.ownerId
      delete record.leaseExpiresAt
      if (!this.persistRecord(record, ownerId)) return finalSummary
      emitRuntimeEvent(executionCtx, {
        type: 'subagent_finished',
        agentId: id,
        taskId: req.taskId,
        payload: { status: record.status, tokens: record.tokens, error: record.error },
      })
      // subagent_stop hook：子任务结束通知（含耗时/token/状态）
      executionCtx.hooks?.clearAgent(executionCtx.sessionId, id)
      await executionCtx.hooks?.fire('subagent_stop', {
        cwd: executionCtx.cwd,
        sessionId: executionCtx.sessionId,
        agentId: id,
        targetAgentId: executionCtx.agentId,
        role: req.role ?? 'fork',
        stats: `status=${record.status} tokens=${record.tokens} duration=${((Date.now() - record.startedAt) / 1000).toFixed(1)}s`,
      })
      this.notifyResult(record)
      return finalSummary
      } catch (error) {
        await cleanupWorktree()
        throw error
      }
    }

    // 后台分流：显式 async 或 fork 强制后台
    if (req.async || req.type === 'fork') {
      const execution = run().catch(async (e) => {
        await this.markError(record, executionCtx, req, e)
      })
      this.activeRuns.set(id, execution)
      void execution.then(
        () => this.finishRun(id),
        () => this.finishRun(id),
      )
      return { id, async: true }
    }

    // 同步等待（30s 上限，超时转后台）
    let timeout: ReturnType<typeof setTimeout> | undefined
    let syncResult: string | typeof SYNC_TIMEOUT
    const execution = run().catch(async (e) => {
      await this.markError(record, executionCtx, req, e)
      throw e
    })
    this.activeRuns.set(id, execution)
    void execution.then(
      () => this.finishRun(id),
      () => this.finishRun(id),
    )
    try {
      syncResult = await Promise.race([
        execution,
        new Promise<typeof SYNC_TIMEOUT>((resolve) => {
          timeout = setTimeout(() => {
            resolve(SYNC_TIMEOUT)
          }, SYNC_MAX_WAIT)
        }),
      ])
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
