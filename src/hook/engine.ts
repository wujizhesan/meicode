import { matchCondition } from './matcher.ts'
import { runCommandAction, runHttpAction, runSubagentAction, DEFAULT_TIMEOUT } from './runner.ts'
import { INTERCEPT_EVENTS } from './types.ts'
import type { HookContext, HookEventName, HookRule } from './types.ts'
import { resolveOnAbort } from '../tools/abort.ts'

export interface HookInjectionLease {
  readonly messages: readonly string[]
  commit(): void
  rollback(): void
}

interface ActiveHookInjectionLease extends HookInjectionLease {
  sessionId?: string
  agentId?: string
  discard(): void
  discardKey(key: string): void
}

export class HookEngine {
  private rules: HookRule[]
  private injections = new Map<string, string[]>()
  private activeLeases = new Set<ActiveHookInjectionLease>()

  constructor(rules: HookRule[]) {
    this.rules = rules
  }

  // 事件分发：once 检查 + 条件匹配 + 动作执行（async 不 await；失败仅日志）
  async fire(event: HookEventName, ctx: HookContext, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    const matched: HookRule[] = []
    for (const rule of this.rules) {
      if (rule.event !== event) continue
      if (rule.once && rule.fired) continue
      try {
        const data = this.buildData(ctx)
        if (rule.if && !matchCondition(data, rule.if)) continue
        matched.push(rule)
      } catch (e) {
        console.warn(`[Hook] ${event} 条件解析失败（已跳过）: ${(e as Error).message}`)
      }
    }
    for (const rule of matched.filter((current) => current.action.type === 'inject_prompt')) {
      if (signal?.aborted) return
      if (rule.once && rule.fired) continue
      try {
        rule.fired = true
        await this.execAction(rule, ctx, signal)
      } catch (e) {
        console.warn(`[Hook] ${event} 规则执行失败（不中断主流程）: ${(e as Error).message}`)
      }
    }
    for (const rule of matched.filter((current) => current.action.type !== 'inject_prompt')) {
      if (signal?.aborted) return
      if (rule.once && rule.fired) continue
      try {
        rule.fired = true
        const run = () => this.execAction(rule, ctx, signal)
        if (rule.async) {
          void run().catch((error: unknown) => {
            if (signal?.aborted) return
            console.warn(`[Hook] ${event} 异步规则执行失败（不中断主流程）: ${(error as Error).message}`)
          })
        }
        else await resolveOnAbort(run, signal, undefined)
      } catch (e) {
        if (signal?.aborted) return
        console.warn(`[Hook] ${event} 规则执行失败（不中断主流程）: ${(e as Error).message}`)
      }
    }
  }

  // tool_before 拦截：命中第一条返回拒绝原因；未命中 null
  async intercept(
    call: { name: string; args: Record<string, unknown> },
    context: string | Omit<HookContext, 'call'>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) return null
    const ctx: HookContext = typeof context === 'string' ? { cwd: context, call } : { ...context, call }
    const data = this.buildData(ctx)
    for (const rule of this.rules) {
      if (rule.event !== 'tool_before') continue
      if (rule.once && rule.fired) continue
      try {
        if (rule.if && !matchCondition(data, rule.if)) continue
      } catch (e) {
        // 坏 hook 配置（如 if.all 非数组）不杀死 agent——跳过该规则
        console.warn(`[Hook] tool_before 条件解析失败，跳过规则: ${(e as Error).message}`)
        continue
      }
      rule.fired = true
      const desc = rule.action.type === 'command' ? `规则要求命令: ${(rule.action as { command: string }).command}` : `规则 ${rule.action.type}`
      return `[Hook 拦截] ${call.name} 被 Hook 规则拦截（${desc}）`
    }
    return null
  }

  collectInjections(context: Pick<HookContext, 'sessionId' | 'agentId'> = {}): string[] {
    const lease = this.checkoutInjections(context)
    lease.commit()
    return [...lease.messages]
  }

  checkoutInjections(context: Pick<HookContext, 'sessionId' | 'agentId'> = {}): HookInjectionLease {
    const exactKey = this.scopeKey(context)
    const keys = [
      this.scopeKey({}),
      this.scopeKey({ sessionId: context.sessionId }),
      this.scopeKey({ agentId: context.agentId }),
      exactKey,
    ].filter((key, index, all) => all.indexOf(key) === index)
    const entries: { key: string; messages: string[] }[] = []
    for (const key of keys) {
      const messages = this.injections.get(key)
      if (messages?.length) entries.push({ key, messages: [...messages] })
      this.injections.delete(key)
    }
    let active = true
    const discardedKeys = new Set<string>()
    const lease: ActiveHookInjectionLease = {
      sessionId: context.sessionId,
      agentId: context.agentId,
      messages: entries.flatMap((entry) => entry.messages),
      commit: () => {
        if (!active) return
        active = false
        this.activeLeases.delete(lease)
      },
      rollback: () => {
        if (!active) return
        lease.commit()
        for (const entry of entries) {
          if (discardedKeys.has(entry.key)) continue
          this.injections.set(entry.key, [...entry.messages, ...(this.injections.get(entry.key) ?? [])])
        }
      },
      discard: () => lease.commit(),
      discardKey: (key) => discardedKeys.add(key),
    }
    if (entries.length > 0) this.activeLeases.add(lease)
    return lease
  }

  resetRound(context: Pick<HookContext, 'sessionId' | 'agentId'> = {}): void {
    const key = this.scopeKey(context)
    this.injections.delete(key)
    for (const lease of this.activeLeases) lease.discardKey(key)
  }

  clearSession(sessionId: string): void {
    for (const lease of [...this.activeLeases]) {
      if (lease.sessionId === sessionId) lease.discard()
    }
    for (const key of this.injections.keys()) {
      try {
        const [storedSessionId] = JSON.parse(key) as [string, string]
        if (storedSessionId === sessionId) this.injections.delete(key)
      } catch {
        this.injections.delete(key)
      }
    }
  }

  clearAgent(sessionId: string | undefined, agentId: string): void {
    const exactKey = this.scopeKey({ sessionId, agentId })
    const agentKey = this.scopeKey({ agentId })
    this.injections.delete(exactKey)
    this.injections.delete(agentKey)
    for (const lease of [...this.activeLeases]) {
      if (lease.agentId !== agentId) continue
      if (lease.sessionId === sessionId) lease.discard()
      else lease.discardKey(agentKey)
    }
  }

  private buildData(ctx: HookContext): Record<string, unknown> {
    return {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      targetAgentId: ctx.targetAgentId,
      name: ctx.call?.name,
      args: ctx.call?.args ?? {},
      content: ctx.message?.content,
      messageRole: ctx.message?.role,
      role: ctx.role ?? ctx.message?.role,
      round: ctx.round,
      decision: ctx.decision,
      reason: ctx.reason,
      stats: ctx.stats,
    }
  }

  private scopeKey(ctx: Pick<HookContext, 'sessionId' | 'agentId'> & { targetAgentId?: string }): string {
    return JSON.stringify([ctx.sessionId ?? '', ctx.targetAgentId ?? ctx.agentId ?? ''])
  }

  private interpolateCommand(command: string, ctx: HookContext): string {
    return command.replace(/\$\{hook\.([\w.]+)\}/g, (_, path: string) => {
      const value = path.split('.').reduce<unknown>((current, key) => (
        current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
      ), ctx)
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
      if (process.platform === 'win32') {
        if (/[\r\n\0&|<>^%!"()]/.test(text)) {
          throw new Error(`Hook 占位符 ${path} 含不安全命令字符；请改用 MEICODE_HOOK_CONTEXT 环境变量`)
        }
        return text
      }
      return `'${text.replaceAll("'", "'\\''")}'`
    })
  }

  private async execAction(rule: HookRule, ctx: HookContext, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    const action = rule.action
    switch (action.type) {
      case 'command': {
        const interpolated = this.interpolateCommand(action.command, ctx)
        const out = await runCommandAction(interpolated, ctx.cwd, action.timeout ?? DEFAULT_TIMEOUT, {
          MEICODE_HOOK_EVENT: rule.event,
          MEICODE_HOOK_CONTEXT: JSON.stringify(ctx),
        }, signal)
        if (signal?.aborted) return
        if (out.trim()) console.warn(`[Hook] command 输出: ${out.slice(0, 200)}`)
        break
      }
      case 'inject_prompt':
        {
          const key = this.scopeKey(ctx)
          const injections = this.injections.get(key) ?? []
          injections.push(action.content)
          this.injections.set(key, injections)
        }
        break
      case 'http':
        runHttpAction(action, signal)
        break
      case 'subagent':
        runSubagentAction(action.name)
        break
    }
  }
}

export { INTERCEPT_EVENTS }
