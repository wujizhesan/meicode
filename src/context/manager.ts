import type { ChatMessage, Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { HookEngine } from '../hook/engine.ts'
import { TokenEstimator, estimateMessageTokens } from './estimate.ts'
import { spillBatch, needsSpill } from './spill.ts'
import { summarize, tailKeep, summaryMessage, boundaryMessage } from './summary.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import { linkAbortSignal } from '../provider/stream.ts'

export interface ContextManagerOptions {
  provider: Provider
  history: History
  cwd: string
  window: number
  autoMargin?: number
  manualMargin?: number
  hooks?: HookEngine // pre/post_compact hook
  sessionId?: string
  agentId?: string
}

export interface ContextBudgetSnapshot {
  window: number
  estimatedTokens: number
  remainingTokens: number
  autoMargin: number
  manualMargin: number
  historyMessages: number
  lastInputTokens?: number
  breakerOpen: boolean
}

export type ContextCompactionResult =
  | { status: 'compacted'; summary: string }
  | { status: 'skipped'; reason: 'below_threshold' | 'insufficient_history' | 'breaker_open' }
  | { status: 'stale' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

export class ContextManager {
  private estimator = new TokenEstimator()
  private failCount = 0
  private breakerOpen = false
  private sessionRevision = 0
  private pendingRequest: {
    mode: 'auto' | 'manual'
    force: boolean
    sessionRevision: number
    controller: AbortController
    promise: Promise<ContextCompactionResult>
  } | null = null
  private provider: Provider
  private history: History
  private cwd: string
  private hooks: HookEngine | undefined
  private sessionId: string | undefined
  private agentId: string | undefined
  private window: number
  private autoMargin: number
  private manualMargin: number
  private lastInputTokens: number | undefined
  private estimateVersion = -1
  private estimateStructureVersion = -1
  private estimatedTokens = 0
  private requestOverheadTokens = 0
  private spillVersion = -1
  private spillLength = 0
  lastSummary: string | null = null

  constructor(opts: ContextManagerOptions) {
    this.provider = opts.provider
    this.history = opts.history
    this.cwd = opts.cwd
    this.window = opts.window
    this.autoMargin = opts.autoMargin ?? Math.min(13000, Math.floor(this.window * 0.1))
    this.manualMargin = opts.manualMargin ?? Math.min(3000, Math.floor(this.window * 0.05))
    this.hooks = opts.hooks
    this.sessionId = opts.sessionId
    this.agentId = opts.agentId
  }

  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId
  }

  reset(): void {
    this.sessionRevision++
    const current = this.pendingRequest
    this.pendingRequest = null
    current?.controller.abort()
    this.estimator = new TokenEstimator()
    this.failCount = 0
    this.breakerOpen = false
    this.lastSummary = null
    this.lastInputTokens = undefined
    this.estimateVersion = -1
    this.estimateStructureVersion = this.history.structureVersion
    this.estimatedTokens = 0
    this.requestOverheadTokens = 0
    this.spillVersion = -1
    this.spillLength = 0
  }

  get breakerOpenState(): boolean {
    return this.breakerOpen
  }

  setRequestOverhead(tokens: number): void {
    if (tokens === this.requestOverheadTokens) return
    this.requestOverheadTokens = tokens
    this.estimateVersion = -1
  }

  snapshot(): ContextBudgetSnapshot {
    const messages = this.history.view()
    const estimatedTokens = this.estimate(messages)
    return {
      window: this.window,
      estimatedTokens,
      remainingTokens: Math.max(0, this.window - estimatedTokens),
      autoMargin: this.autoMargin,
      manualMargin: this.manualMargin,
      historyMessages: messages.length,
      ...(this.lastInputTokens === undefined ? {} : { lastInputTokens: this.lastInputTokens }),
      breakerOpen: this.breakerOpen,
    }
  }

  beforeRequest(mode: 'auto' | 'manual', signal?: AbortSignal, options: { force?: boolean } = {}): Promise<ContextCompactionResult> {
    return this.runRequest(mode, signal, options.force ?? false)
  }

  compact(): Promise<ContextCompactionResult> {
    return this.runRequest('manual')
  }

  private async runRequest(mode: 'auto' | 'manual', signal?: AbortSignal, force = false): Promise<ContextCompactionResult> {
    if (signal?.aborted) return { status: 'cancelled' }
    const current = this.pendingRequest
    if (current) {
      const result = await resolveOnAbort<ContextCompactionResult>(current.promise, signal, { status: 'cancelled' })
      if (result.status === 'skipped' && (current.mode !== mode || (force && !current.force))
        && current.sessionRevision === this.sessionRevision) {
        return this.runRequest(mode, signal, force)
      }
      return result
    }
    const sessionRevision = this.sessionRevision
    const linked = linkAbortSignal(signal)
    const request = {
      mode,
      force,
      sessionRevision,
      controller: linked.controller,
      promise: resolveOnAbort<ContextCompactionResult>(() => Promise.resolve().then<ContextCompactionResult>(() => {
        if (sessionRevision !== this.sessionRevision) return { status: 'stale' }
        return this.prepareRequest(mode, linked.controller.signal, force)
      }), linked.controller.signal, { status: 'cancelled' }).then<ContextCompactionResult>((result) => {
        return sessionRevision === this.sessionRevision ? result : { status: 'stale' }
      }),
    }
    this.pendingRequest = request
    try {
      return await request.promise
    } finally {
      linked.dispose()
      if (this.pendingRequest === request) this.pendingRequest = null
    }
  }

  private async prepareRequest(mode: 'auto' | 'manual', signal?: AbortSignal, force = false): Promise<ContextCompactionResult> {
    if (signal?.aborted) return { status: 'cancelled' }
    const sessionRevision = this.sessionRevision
    // ① 轻量预防：扫描未存盘的大 tool 消息 → 存盘
    let msgs = this.history.view()
    const historyVersion = this.history.version
    const appendedOnly = this.spillVersion >= 0
      && historyVersion - this.spillVersion === msgs.length - this.spillLength
      && msgs.length >= this.spillLength
    const scanStart = appendedOnly ? this.spillLength : 0
    let didSpill = false
    for (let i = scanStart; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role === 'tool' && needsSpill(m.content) && !m.content.includes('[已存盘]')) {
        const [spilled] = await spillBatch([{ content: m.content }], this.cwd)
        if (sessionRevision !== this.sessionRevision) return { status: 'stale' }
        if (signal?.aborted) return { status: 'cancelled' }
        this.history.replaceRange(i, i + 1, [{ ...m, content: spilled.content }])
        didSpill = true
      }
    }
    if (didSpill) msgs = this.history.view()
    this.spillVersion = this.history.version
    this.spillLength = msgs.length

    // ② 重量兜底：估算超限 → 摘要
    const margin = mode === 'manual' ? this.manualMargin : this.autoMargin
    if (this.breakerOpen && mode === 'auto') return { status: 'skipped', reason: 'breaker_open' }
    const total = this.estimate(msgs)
    if (!force && total <= this.window - margin) return { status: 'skipped', reason: 'below_threshold' }

    // 保留尾部：约 1 万 token 或 ≥5 条；小窗口下按窗口 10% 收缩（防 keep 大于窗口）
    const keepTokens = Math.min(10000, Math.floor(this.window * 0.1))
    const structureVersion = this.history.structureVersion
    const { keep, drop } = tailKeep(msgs, keepTokens)
    if (drop.length === 0) return { status: 'skipped', reason: 'insufficient_history' }

    let appliedSummary: string | undefined
    try {
      // pre_compact hook：压缩前通知（存档关键信息/审计）
      await this.hooks?.fire('pre_compact', {
        cwd: this.cwd,
        sessionId: this.sessionId,
        agentId: this.agentId,
        stats: `drop=${drop.length}msgs keep=${keep.length}msgs`,
      }, signal)
      if (sessionRevision !== this.sessionRevision || structureVersion !== this.history.structureVersion) return { status: 'stale' }
      if (signal?.aborted) return { status: 'cancelled' }
      const summary = await summarize(this.provider, drop, { cwd: this.cwd, timeoutMs: 60000, signal })
      if (sessionRevision !== this.sessionRevision || structureVersion !== this.history.structureVersion) return { status: 'stale' }
      if (signal?.aborted) return { status: 'cancelled' }
      const replacement = [summaryMessage(summary), boundaryMessage()]
      const originalTokens = drop.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      const summaryTokens = replacement.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      if (summaryTokens >= originalTokens) {
        throw new Error(`摘要未减少上下文（估算 ${originalTokens} → ${summaryTokens} tokens），已保留原历史`)
      }
      this.lastSummary = summary
      this.history.replaceRange(0, drop.length, replacement)
      appliedSummary = summary
      this.spillVersion = this.history.version
      this.spillLength = this.history.length
      this.failCount = 0
      this.breakerOpen = false
      // post_compact hook：压缩完成（校验/记录）
      await this.hooks?.fire('post_compact', {
        cwd: this.cwd,
        sessionId: this.sessionId,
        agentId: this.agentId,
        stats: `dropped=${drop.length}msgs → summary=${summary.length}chars`,
      }, signal)
      if (sessionRevision !== this.sessionRevision) return { status: 'stale' }
      return { status: 'compacted', summary }
    } catch (e) {
      if (sessionRevision !== this.sessionRevision) return { status: 'stale' }
      if (appliedSummary !== undefined) return { status: 'compacted', summary: appliedSummary }
      if (structureVersion !== this.history.structureVersion) return { status: 'stale' }
      if (signal?.aborted) return { status: 'cancelled' }
      this.failCount++
      if (this.failCount >= 3) {
        this.breakerOpen = true
        console.warn(`[上下文] 摘要连续失败 ${this.failCount} 次，本次会话停止自动摘要（/compact 仍可用）`)
      }
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
    }
  }

  afterRequest(usageInputTokens: number, messageCount: number, overheadTokens = this.requestOverheadTokens): void {
    this.lastInputTokens = usageInputTokens
    this.estimator.update(usageInputTokens, messageCount, overheadTokens)
    this.estimateStructureVersion = this.history.structureVersion
    this.estimateVersion = -1
  }

  private estimate(messages: readonly ChatMessage[]): number {
    if (this.estimateStructureVersion !== this.history.structureVersion) {
      this.estimator = new TokenEstimator()
      this.estimateStructureVersion = this.history.structureVersion
      this.estimateVersion = -1
    }
    if (this.estimateVersion !== this.history.version) {
      this.estimatedTokens = this.estimator.estimate(messages, this.requestOverheadTokens)
      this.estimateVersion = this.history.version
    }
    return this.estimatedTokens
  }
}

export { TokenEstimator } from './estimate.ts'
export { spillBatch, spillContent, needsSpill, SPILL_THRESHOLD, BATCH_THRESHOLD, PREVIEW_LEN } from './spill.ts'
export { summarize, tailKeep, summaryMessage, boundaryMessage, SUMMARY_SYSTEM, BOUNDARY_MESSAGE } from './summary.ts'
