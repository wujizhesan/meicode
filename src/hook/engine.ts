import { matchCondition } from './matcher.ts'
import { runCommandAction, runHttpAction, runSubagentAction, DEFAULT_TIMEOUT } from './runner.ts'
import { INTERCEPT_EVENTS } from './types.ts'
import type { HookContext, HookEventName, HookRule } from './types.ts'

export class HookEngine {
  private rules: HookRule[]
  private injections = new Map<string, string[]>()

  constructor(rules: HookRule[]) {
    this.rules = rules
  }

  // 事件分发：once 检查 + 条件匹配 + 动作执行（async 不 await；失败仅日志）
  async fire(event: HookEventName, ctx: HookContext): Promise<void> {
    const matched: HookRule[] = []
    for (const rule of this.rules) {
      if (rule.event !== event) continue
      if (rule.once && rule.fired) continue
      try {
        const data = this.buildData(ctx)
        if (rule.if && !matchCondition(data, rule.if)) continue
        rule.fired = true
        matched.push(rule)
      } catch (e) {
        console.warn(`[Hook] ${event} 条件解析失败（已跳过）: ${(e as Error).message}`)
      }
    }
    for (const rule of matched.filter((current) => current.action.type === 'inject_prompt')) {
      try {
        await this.execAction(rule, ctx)
      } catch (e) {
        console.warn(`[Hook] ${event} 规则执行失败（不中断主流程）: ${(e as Error).message}`)
      }
    }
    for (const rule of matched.filter((current) => current.action.type !== 'inject_prompt')) {
      try {
        const run = () => this.execAction(rule, ctx)
        if (rule.async) {
          void run().catch((error: unknown) => {
            console.warn(`[Hook] ${event} 异步规则执行失败（不中断主流程）: ${(error as Error).message}`)
          })
        }
        else await run()
      } catch (e) {
        console.warn(`[Hook] ${event} 规则执行失败（不中断主流程）: ${(e as Error).message}`)
      }
    }
  }

  // tool_before 拦截：命中第一条返回拒绝原因；未命中 null
  async intercept(
    call: { name: string; args: Record<string, unknown> },
    context: string | Omit<HookContext, 'call'>,
  ): Promise<string | null> {
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
    const exactKey = this.scopeKey(context)
    const keys = [
      this.scopeKey({}),
      this.scopeKey({ sessionId: context.sessionId }),
      this.scopeKey({ agentId: context.agentId }),
      exactKey,
    ].filter((key, index, all) => all.indexOf(key) === index)
    const collected = keys.flatMap((key) => this.injections.get(key) ?? [])
    for (const key of keys) this.injections.delete(key)
    return [...collected]
  }

  resetRound(context: Pick<HookContext, 'sessionId' | 'agentId'> = {}): void {
    this.injections.delete(this.scopeKey(context))
  }

  clearSession(sessionId: string): void {
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
    this.injections.delete(this.scopeKey({ sessionId, agentId }))
    this.injections.delete(this.scopeKey({ agentId }))
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

  private async execAction(rule: HookRule, ctx: HookContext): Promise<void> {
    const action = rule.action
    switch (action.type) {
      case 'command': {
        const interpolated = this.interpolateCommand(action.command, ctx)
        const out = await runCommandAction(interpolated, ctx.cwd, action.timeout ?? DEFAULT_TIMEOUT, {
          MEICODE_HOOK_EVENT: rule.event,
          MEICODE_HOOK_CONTEXT: JSON.stringify(ctx),
        })
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
        runHttpAction(action)
        break
      case 'subagent':
        runSubagentAction(action.name)
        break
    }
  }
}

export { INTERCEPT_EVENTS }
