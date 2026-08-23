import type { Provider } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import type { HookEngine } from '../hook/engine.ts'
import { TokenEstimator } from './estimate.ts'
import { spillBatch, needsSpill, SPILL_THRESHOLD } from './spill.ts'
import { summarize, tailKeep, summaryMessage, boundaryMessage } from './summary.ts'

export interface ContextManagerOptions {
  provider: Provider
  history: History
  cwd: string
  window: number
  autoMargin?: number // 自动触发余量（默认 13000）
  manualMargin?: number // 手动触发余量（默认 3000）
  hooks?: HookEngine // pre/post_compact hook
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

export class ContextManager {
  private estimator = new TokenEstimator()
  private failCount = 0
  private breakerOpen = false
  private provider: Provider
  private history: History
  private cwd: string
  private hooks: HookEngine | undefined
  private window: number
  private autoMargin: number
  private manualMargin: number
  private lastInputTokens: number | undefined
  lastSummary: string | null = null

  constructor(opts: ContextManagerOptions) {
    this.provider = opts.provider
    this.history = opts.history
    this.cwd = opts.cwd
    this.window = opts.window
    this.autoMargin = opts.autoMargin ?? 13000
    this.manualMargin = opts.manualMargin ?? 3000
    this.hooks = opts.hooks
  }

  get breakerOpenState(): boolean {
    return this.breakerOpen
  }

  snapshot(): ContextBudgetSnapshot {
    const estimatedTokens = this.estimator.estimate(this.history.all())
    return {
      window: this.window,
      estimatedTokens,
      remainingTokens: Math.max(0, this.window - estimatedTokens),
      autoMargin: this.autoMargin,
      manualMargin: this.manualMargin,
      historyMessages: this.history.all().length,
      ...(this.lastInputTokens === undefined ? {} : { lastInputTokens: this.lastInputTokens }),
      breakerOpen: this.breakerOpen,
    }
  }

  async beforeRequest(mode: 'auto' | 'manual'): Promise<void> {
    // ① 轻量预防：扫描未存盘的大 tool 消息 → 存盘
    const msgs = this.history.all()
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role === 'tool' && needsSpill(m.content) && !m.content.includes('[已存盘]')) {
        const [spilled] = await spillBatch([{ content: m.content }], this.cwd)
        this.history.replaceRange(i, i + 1, [{ ...m, content: spilled.content }])
      }
    }

    // ② 重量兜底：估算超限 → 摘要
    const margin = mode === 'manual' ? this.manualMargin : this.autoMargin
    if (this.breakerOpen && mode === 'auto') return
    const total = this.estimator.estimate(this.history.all())
    if (total <= this.window - margin) return

    // 保留尾部：约 1 万 token 或 ≥5 条；小窗口下按窗口 10% 收缩（防 keep 大于窗口）
    const keepTokens = Math.min(10000, Math.floor(this.window * 0.1))
    const { keep, drop } = tailKeep(this.history.all(), keepTokens)
    if (drop.length === 0) return

    try {
      // pre_compact hook：压缩前通知（存档关键信息/审计）
      await this.hooks?.fire('pre_compact', {
        cwd: this.cwd,
        stats: `drop=${drop.length}msgs keep=${keep.length}msgs`,
      })
      const summary = await summarize(this.provider, drop, { cwd: this.cwd, timeoutMs: 60000 })
      this.lastSummary = summary
      this.history.replaceRange(0, drop.length, [summaryMessage(summary), boundaryMessage()])
      this.failCount = 0
      this.breakerOpen = false
      // post_compact hook：压缩完成（校验/记录）
      await this.hooks?.fire('post_compact', {
        cwd: this.cwd,
        stats: `dropped=${drop.length}msgs → summary=${summary.length}chars`,
      })
    } catch (e) {
      this.failCount++
      if (this.failCount >= 3) {
        this.breakerOpen = true
        console.warn(`[上下文] 摘要连续失败 ${this.failCount} 次，本次会话停止自动摘要（/compact 仍可用）`)
      }
    }
  }

  afterRequest(usageInputTokens: number, messageCount: number): void {
    this.lastInputTokens = usageInputTokens
    this.estimator.update(usageInputTokens, messageCount)
  }
}

export { TokenEstimator } from './estimate.ts'
export { spillBatch, spillContent, needsSpill, SPILL_THRESHOLD, BATCH_THRESHOLD, PREVIEW_LEN } from './spill.ts'
export { summarize, tailKeep, summaryMessage, boundaryMessage, SUMMARY_SYSTEM, BOUNDARY_MESSAGE } from './summary.ts'
