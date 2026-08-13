import { matchCondition } from './matcher.ts'
import { runCommandAction, runHttpAction, runSubagentAction, DEFAULT_TIMEOUT } from './runner.ts'
import { INTERCEPT_EVENTS } from './types.ts'
import type { HookContext, HookEventName, HookRule } from './types.ts'

export class HookEngine {
  private rules: HookRule[]
  private injections: string[] = []

  constructor(rules: HookRule[]) {
    this.rules = rules
  }

  // 事件分发：once 检查 + 条件匹配 + 动作执行（async 不 await；失败仅日志）
  async fire(event: HookEventName, ctx: HookContext): Promise<void> {
    for (const rule of this.rules) {
      if (rule.event !== event) continue
      if (rule.once && rule.fired) continue
      try {
        const data = this.buildData(ctx)
        if (rule.if && !matchCondition(data, rule.if)) continue
        rule.fired = true
        const run = () => this.execAction(rule, ctx)
        if (rule.async) void run()
        else await run()
      } catch (e) {
        console.warn(`[Hook] ${event} 规则执行失败（不中断主流程）: ${(e as Error).message}`)
      }
    }
  }

  // tool_before 拦截：命中第一条返回拒绝原因；未命中 null
  async intercept(call: { name: string; args: Record<string, unknown> }, cwd: string): Promise<string | null> {
    const ctx: HookContext = { cwd, call }
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

  collectInjections(): string[] {
    return [...this.injections]
  }

  resetRound(): void {
    this.injections = []
  }

  private buildData(ctx: HookContext): Record<string, unknown> {
    return {
      name: ctx.call?.name,
      args: ctx.call?.args ?? {},
      content: ctx.message?.content,
      role: ctx.message?.role,
      round: ctx.round,
    }
  }

  private async execAction(rule: HookRule, ctx: HookContext): Promise<void> {
    const action = rule.action
    switch (action.type) {
      case 'command': {
        // ${hook.xxx} 占位符插值——事件数据传给命令（审计/自动决策场景）
        const interpolated = action.command.replace(/\$\{hook\.([\w.]+)\}/g, (_, path: string) => {
          const val = path.split('.').reduce<unknown>((o, k) => (o ? (o as Record<string, unknown>)[k] : undefined), ctx)
          return typeof val === 'string' ? val : JSON.stringify(val ?? '')
        })
        const out = await runCommandAction(interpolated, ctx.cwd, action.timeout ?? DEFAULT_TIMEOUT)
        if (out.trim()) console.warn(`[Hook] command 输出: ${out.slice(0, 200)}`)
        break
      }
      case 'inject_prompt':
        this.injections.push(action.content)
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
