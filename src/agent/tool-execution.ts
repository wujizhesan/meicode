import type { StreamEvent } from '../provider/types.ts'
import { checkPermission } from '../permission/index.ts'
import type { Rule } from '../permission/types.ts'
import type { ToolContext, ToolResult, ToolRegistry } from '../tools/index.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import { READ_ONLY_TOOLS } from './loop-guards.ts'
import { commandRuleValue } from '../permission/command-policy.ts'
import { shotDiffOutputRuleValue } from '../tools/shot_diff_path.ts'
import { browserRuleValue } from '../tools/browser_path.ts'

export type ToolCall = Extract<StreamEvent, { type: 'tool_call' }>

export interface ExecutedToolCall {
  call: ToolCall
  result: ToolResult
}

export async function executeToolBatch(
  calls: ToolCall[],
  registry: ToolRegistry,
  context: ToolContext,
  onResult: (call: ToolCall, result: ToolResult) => void | Promise<void>,
  canExecute?: () => boolean,
  allowedTools?: ReadonlySet<string>,
): Promise<ExecutedToolCall[]> {
  const byId = new Map<string, ToolResult>()
  let pendingReads: ToolCall[] = []

  const flushReads = async (): Promise<void> => {
    const batch = pendingReads
    pendingReads = []
    await Promise.all(batch.map(async (call) => {
      const result = await executeToolCall(call, registry, context, canExecute, allowedTools)
      byId.set(call.id, result)
      await onResult(call, result)
    }))
  }

  for (const call of calls) {
    if (READ_ONLY_TOOLS.has(call.name)) {
      pendingReads.push(call)
      continue
    }
    await flushReads()
    const result = await executeToolCall(call, registry, context, canExecute, allowedTools)
    byId.set(call.id, result)
    await onResult(call, result)
  }
  await flushReads()

  return calls.map((call) => ({ call, result: byId.get(call.id)! }))
}

export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  context: ToolContext,
  canExecute?: () => boolean,
  allowedTools?: ReadonlySet<string>,
): Promise<ToolResult> {
  const cancelled: ToolResult = { success: false, output: '', error: '工具执行已取消' }
  const shouldStop = (): boolean => !!context.signal?.aborted || canExecute?.() === false
  if (shouldStop()) return cancelled
  const tool = registry.get(call.name)
  if (!tool) return { success: false, output: '', error: `未找到工具: ${call.name}` }
  if (allowedTools && !allowedTools.has(call.name)) {
    return { success: false, output: '', error: `[工具限制] ${call.name} 不在本轮允许列表中，已拒绝执行` }
  }
  const args = normalizeArgs(call.arguments)

  if (context.permission) {
    const decision = await checkPermission({ name: call.name, args }, {
      cwd: context.cwd,
      sessionId: context.sessionId,
      mode: context.permission.mode,
      engine: context.permission.engine,
      autoAcceptEdits: context.permission.autoAcceptEdits,
      allowedWritePaths: [
        ...(context.rootLock ? [context.rootLock] : []),
        ...(context.rootLockExtra ?? []),
      ],
    })
    if (shouldStop()) return cancelled
    if (decision.type === 'ask') {
      await resolveOnAbort(async () => context.hooks?.fire('permission_request', {
        cwd: context.cwd,
        sessionId: context.sessionId,
        agentId: context.agentId,
        call: { name: call.name, args },
        decision: 'ask',
      }, context.signal), context.signal, undefined)
      if (shouldStop()) return cancelled
      if (!context.ask) return { success: false, output: '', error: '[权限拒绝] 需要用户确认（无确认通道）' }
      const answer = await resolveOnAbort(
        () => context.ask!({ name: call.name, args, reason: decision.reason }, context.signal),
        context.signal,
        'deny',
      )
      if (shouldStop()) return cancelled
      const allowRule: Omit<Rule, 'source'> = {
        tool: call.name,
        pattern: approvalPattern(call.name, args),
        action: 'allow',
      }
      if (answer === 'session') {
        context.permission.engine.addSessionRule(allowRule, context.sessionId)
      } else if (answer === 'forever') {
        context.permission.engine.appendProjectRule(allowRule)
      } else if (answer !== 'once') {
        return { success: false, output: '', error: '[权限拒绝] 用户拒绝' }
      }
    } else if (decision.type === 'deny') {
      await resolveOnAbort(async () => context.hooks?.fire('permission_denied', {
        cwd: context.cwd,
        sessionId: context.sessionId,
        agentId: context.agentId,
        call: { name: call.name, args },
        decision: 'deny',
        reason: decision.reason ?? '',
      }, context.signal), context.signal, undefined)
      if (shouldStop()) return cancelled
      return { success: false, output: '', error: `[权限拒绝] ${decision.reason}` }
    }
  }

  if (shouldStop()) return cancelled
  const blocked = context.hooks ? await resolveOnAbort(() => context.hooks!.intercept({ name: call.name, args }, {
    cwd: context.cwd,
    sessionId: context.sessionId,
    agentId: context.agentId,
  }, context.signal), context.signal, null) : null
  if (shouldStop()) return cancelled
  if (blocked) return { success: false, output: '', error: blocked }

  try {
    return await tool.execute(args, context)
  } catch (error) {
    return { success: false, output: '', error: `工具执行异常: ${(error as Error).message}` }
  }
}

export function approvalPattern(name: string, args: Record<string, unknown>): string {
  if (name === 'run_command') return commandRuleValue(args) ?? '*'
  if (name === 'shot_diff') return shotDiffOutputRuleValue(args)
  if (name === 'browser') return browserRuleValue(args)
  const value = args.command ?? args.path ?? args.pattern
  if (typeof value !== 'string') return '*'
  return value
}

const ARG_ALIASES: Record<string, string[]> = {
  path: ['file_path', 'filepath', 'target', 'file'],
  name: ['tool_name', 'toolName', 'tool'],
  command: ['cmd', 'command_line', 'shell_command'],
  content: ['text', 'body', 'data'],
  pattern: ['glob', 'search', 'query'],
  args: ['arguments', 'params'],
  old_text: ['old', 'oldText', 'old_content'],
  new_text: ['new', 'newText', 'new_content'],
}

export function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...raw }
  for (const [canonical, aliases] of Object.entries(ARG_ALIASES)) {
    if (normalized[canonical] !== undefined) continue
    for (const alias of aliases) {
      if (normalized[alias] !== undefined) {
        normalized[canonical] = normalized[alias]
        break
      }
    }
  }
  return normalized
}
