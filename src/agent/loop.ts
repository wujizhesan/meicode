import type { ChatMessage, Provider, StreamEvent } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { sanitizeMessages } from '../memory/session.ts'
import { log } from '../log.ts'
import type { ToolContext, ToolResult, ToolRegistry } from '../tools/index.ts'
import type { AgentEvent, AgentHandle, AgentOptions, AgentResult, StopReason } from './events.ts'
import { buildSystemPrompt, buildEnvironmentInfo, sessionDirective } from './prompt/index.ts'
import { checkPermission } from '../permission/index.ts'
import type { Rule } from '../permission/types.ts'

const READ_ONLY_TOOLS = new Set(['read_file', 'find_files', 'grep_code'])
// 写类工具:重复检测阈值(5 次)——写死循环仍止损,但写同一文件迭代(报告草稿/读回再写)是合法场景,
// 3 次误杀过主会话写报告(实战实锤)
const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

export function runAgent(opts: AgentOptions): AgentHandle {
  const { provider, history, registry, ctx, maxIterations, mode, unknownToolLimit } = opts
  const controller = new AbortController()

  // ---------- 事件流 ----------
  const eventQueue: AgentEvent[] = []
  let eventWake: (() => void) | null = null
  let finished = false

  const emit = (ev: AgentEvent) => {
    eventQueue.push(ev)
    if (ev.type === 'done') finished = true
    if (eventWake) {
      const w = eventWake
      eventWake = null
      w()
    }
  }

  const events: AsyncIterable<AgentEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!
        } else if (finished) {
          return
        } else {
          await new Promise<void>((r) => {
            eventWake = r
          })
        }
      }
    },
  }

  // ---------- 执行体 ----------
  const donePromise = (async (): Promise<AgentResult> => {
    let round = 0
    let totalTokens = 0
    let unknownStreak = 0
    let finalText = ''
    let reason: StopReason = 'complete'
    let roundErrorMessage: string | null = null
    let fatalError: string | null = null
    let toolFailStreak = 0
    let compactRetries = 0 // 超限自动压缩重试计数(最多 2 次)
    // 重复工具调用检测(对齐 Zcode):最近窗口内同一签名 ≥3 次 → 停止(防死循环烧 token)
    const recentCallSigs: string[] = []
    const REPEAT_WINDOW = 6

    // 主 system：稳定前缀（与轮次无关，逐字节一致以命中缓存）
    const systemMain = opts.systemPrompt || buildSystemPrompt(mode)
    // P10：Skill 白名单收窄优先于模式过滤
    const tools = opts.toolsOverride ?? (mode === 'plan'
      ? registry.toOpenAITools().filter((t) => READ_ONLY_TOOLS.has(t.function.name))
      : registry.toOpenAITools())

    try {
    for (round = 1; round <= maxIterations; round++) {
      if (controller.signal.aborted) {
        reason = 'cancelled'
        break
      }
      emit({ type: 'progress', round, max: maxIterations, status: mode === 'plan' ? '计划中' : '执行中' })

      // P11：round_start Hook（注入缓冲本轮生效）
      await ctx.hooks?.fire('round_start', { cwd: ctx.cwd, round })
      const hookInjections = ctx.hooks?.collectInjections() ?? []

      const roundCalls: Extract<StreamEvent, { type: 'tool_call' }>[] = []
      let roundText = ''
      let roundError: string | null = null

      // P7：请求前上下文检查（轻量预防 + 重量兜底）
      await ctx.beforeRequest?.('auto')

      log('info', `round ${round}/${maxIterations} 请求 model=${opts.systemPrompt ? 'custom' : mode} msgs=${history.length}`)
      const directive = sessionDirective(mode, round)
      const remaining = maxIterations - round
      // 轮次提醒：剩余 ≤3 轮时报告优先——防成员分析占满轮次收尾不完整(实战实锤: jsr/rm 轮尽报告未落盘)
      const endgameHint =
        remaining <= 3
          ? [{ role: 'system' as const, content: `[系统] 剩余 ${remaining} 轮。如果任务需要产出报告（write_paths 契约目录，如 D:\\reverse-notes\\），立即用 write_file 写入——报告优先于继续深入分析。` }]
          : []
      const msgs: ChatMessage[] = [
        { role: 'system', content: systemMain },
        { role: 'system', content: buildEnvironmentInfo(ctx) },
        ...(directive ? [{ role: 'system' as const, content: directive }] : []),
        ...(opts.extraSystemMessages?.map((c) => ({ role: 'system' as const, content: c })) ?? []),
        ...hookInjections.map((c) => ({ role: 'system' as const, content: c })),
        ...endgameHint,
        // P14：请求前 sanitize——任何路径产生的不完整 assistant(tool_calls) 都被过滤（防 DeepSeek 400）
        ...sanitizeMessages(history.all()),
      ]
      // P12：请求前注入回流结果——追加在末尾（请求时历史是稳定快照，永不插 assistant/tool 中间）
      for (const c of opts.injectSystem?.() ?? []) {
        msgs.push({ role: 'system', content: c })
      }

      for await (const ev of provider.streamChat(msgs, { thinking: false, tools, signal: controller.signal })) {
        if (controller.signal.aborted) break
        if (ev.type === 'text') {
          roundText += ev.text
          emit({ type: 'text', text: ev.text })
        } else if (ev.type === 'thinking') {
          emit({ type: 'thinking', text: ev.text })
        } else if (ev.type === 'tool_call') {
          roundCalls.push(ev)
        } else if (ev.type === 'usage') {
          totalTokens += ev.inputTokens + ev.outputTokens
          ctx.afterRequest?.(ev.inputTokens, history.length)
          emit({
            type: 'usage',
            round,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cacheHitTokens: ev.cacheHitTokens,
            cacheMissTokens: ev.cacheMissTokens,
          })
        } else if (ev.type === 'error') {
          roundError = ev.message
        }
      }

      if (controller.signal.aborted) {
        reason = 'cancelled'
        break
      }
      if (roundError) {
        // 上下文超限自动恢复(对齐 Zcode):强制压缩后重试本轮,最多 2 次
        // 此前 400 上下文爆炸直接结束——现在能自救
        if (/context|exceed|token limit|maximum|too long/i.test(roundError) && ctx.beforeRequest && compactRetries < 2) {
          compactRetries++
          log('info', `上下文超限,自动压缩重试(${compactRetries}/2): ${roundError.slice(0, 120)}`)
          await ctx.beforeRequest('manual')
          continue
        }
        reason = 'error'
        roundErrorMessage = roundError
        break
      }

      if (roundCalls.length === 0) {
        if (roundText) history.push({ role: 'assistant', content: roundText })
        // 团队任务还在执行时纯文本不算完成——模型把"[等待]"当最终输出会中断编排(实战多轮实锤)
        if (opts.teamBusy?.()) {
          log('info', '团队任务执行中,纯文本轮不判 complete,注入提示继续轮询')
          history.push({
            role: 'user',
            content:
              '[系统] 团队任务仍在执行中（存在 in_progress 任务）。请继续用 team_mail/team_tasks 轮询状态，或主动催办/降级收尾——不要输出总结文本结束本轮。',
          })
          continue
        }
        finalText = roundText
        reason = 'complete'
        break
      }

      const allUnknown = roundCalls.every((c) => !registry.get(c.name))
      if (allUnknown) {
        unknownStreak++
      } else {
        unknownStreak = 0
      }

      // 重复工具调用检测:同一签名(工具+参数)窗口内 ≥N 次 → 停止(防死循环烧 token)
      // 未知工具跳过(走 unknownStreak);查询类工具豁免——轮询状态是合法行为
      // 写类工具严格(3 次即停,写死循环代价高);run_command 等放宽(5):调研命令密集合法(实战误伤)
      const REPEAT_STOP = (name: string) => (WRITE_TOOLS.has(name) ? 5 : 5)
      let repeatStop = false
      for (const c of roundCalls) {
        if (!registry.get(c.name)) continue
        if (READ_ONLY_TOOLS.has(c.name) || c.name === 'team_tasks' || c.name === 'team_mail') continue
        const sig = `${c.name}:${JSON.stringify(c.arguments).slice(0, 100)}`
        recentCallSigs.push(sig)
        if (recentCallSigs.length > REPEAT_WINDOW) recentCallSigs.shift()
        const count = recentCallSigs.filter((s) => s === sig).length
        if (count >= REPEAT_STOP(c.name)) {
          repeatStop = true
          roundErrorMessage = `重复调用工具 ${c.name} ${count} 次(相同参数),已停止——换个方式或询问用户`
          log('info', `重复工具调用 ${c.name} ×${count},停止`)
          break
        }
      }
      if (repeatStop) {
        reason = 'tool_repeat'
        break
      }

      history.push({
        role: 'assistant',
        content: roundText,
        tool_calls: roundCalls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })),
      })

      const executed = await executeBatch(roundCalls, registry, ctx, (call, result) => {
        // P11：tool_after Hook
        void ctx.hooks?.fire('tool_after', { cwd: ctx.cwd, call: { name: call.name, args: call.arguments } })
        log('info', `tool ${call.name} ${result.success ? 'ok' : 'fail'}${result.error ? `: ${result.error.slice(0, 120)}` : ''}`)
        emit({
          type: 'tool_result',
          id: call.id,
          name: call.name,
          success: result.success,
          summary: result.success ? (result.truncated ? '成功（结果已截断）' : '成功') : (result.error ?? '失败'),
        })
      })
      // 连续工具失败止损：≥3 轮全失败停止（防模型死磕烧 token）
      const allFailed = executed.length > 0 && executed.every(({ result }) => !result.success)
      let stopEarly = false
      if (allFailed) {
        toolFailStreak++
        if (toolFailStreak >= 3) {
          reason = 'tool_failures'
          roundErrorMessage = '工具连续失败 3 轮，已停止（建议检查环境或换一种方式）'
          stopEarly = true
        }
      } else {
        toolFailStreak = 0
      }

      // P7：大工具结果存盘（轻量预防）——回灌前处理；失败降级为原样保留，不阻塞主流程
      let spillResults = executed.map(({ result }) => ({ content: result.success ? result.output : `[失败] ${result.error}` }))
      if (ctx.spill) {
        try {
          spillResults = await ctx.spill(spillResults)
        } catch (e) {
          console.warn(`[上下文] 存盘失败（降级原样保留）: ${(e as Error).message}`)
        }
      }
      for (let i = 0; i < executed.length; i++) {
        history.push({
          role: 'tool',
          tool_call_id: executed[i].call.id,
          content: spillResults[i].content,
        })
      }
      // 止损标记：工具结果已完整回灌后再停止（保证 assistant(tool_calls) 有配对 tool 消息）
      if (stopEarly) {
        break
      }

      if (unknownStreak >= unknownToolLimit) {
        reason = 'unknown_tool'
        break
      }
    }

    } catch (e) {
      // 任何异常必须转 done 事件，UI 才能收尾（否则事件流永久等待）
      fatalError = `Agent 循环异常: ${(e as Error).message}`
      reason = 'error'
      log('error', `agent loop fatal: ${(e as Error).message}`)
    }
    log('info', `agent 结束 reason=${reason} rounds=${Math.min(round, maxIterations)} tokens=${totalTokens}`)
    if (round > maxIterations) reason = 'max_iterations'
    // P11：round_end + 清注入缓冲（所有退出路径统一）
    try {
      await ctx.hooks?.fire('round_end', { cwd: ctx.cwd, round: Math.min(round, maxIterations) })
    } catch {
      // 忽略
    }
    ctx.hooks?.resetRound()
    emit({
      type: 'done',
      reason,
      rounds: Math.min(round, maxIterations),
      totalTokens,
      ...(roundErrorMessage ? { errorMessage: roundErrorMessage } : {}),
      ...(fatalError ? { errorMessage: fatalError } : {}),
    })
    return { reason, rounds: Math.min(round, maxIterations), totalTokens, finalText, ...(roundErrorMessage ? { errorMessage: roundErrorMessage } : {}) }
  })()

  return {
    events,
    cancel: () => controller.abort(),
    done: donePromise,
  }
}

// ---------- 多工具分批执行：读并发 / 写串行 ----------
async function executeBatch(
  calls: Extract<StreamEvent, { type: 'tool_call' }>[],
  registry: ToolRegistry,
  ctx: ToolContext,
  onResult: (call: Extract<StreamEvent, { type: 'tool_call' }>, result: ToolResult) => void,
): Promise<{ call: Extract<StreamEvent, { type: 'tool_call' }>; result: ToolResult }[]> {
  const reads = calls.filter((c) => READ_ONLY_TOOLS.has(c.name))
  const others = calls.filter((c) => !READ_ONLY_TOOLS.has(c.name))

  const readResults = await Promise.all(
    reads.map(async (call) => {
      const result = await executeOne(call, registry, ctx)
      onResult(call, result)
      return { call, result }
    }),
  )
  const otherResults: { call: Extract<StreamEvent, { type: 'tool_call' }>; result: ToolResult }[] = []
  for (const call of others) {
    const result = await executeOne(call, registry, ctx)
    onResult(call, result)
    otherResults.push({ call, result })
  }

  const byId = new Map<string, ToolResult>()
  for (const r of [...readResults, ...otherResults]) byId.set(r.call.id, r.result)
  return calls.map((call) => ({ call, result: byId.get(call.id)! }))
}

async function executeOne(
  call: Extract<StreamEvent, { type: 'tool_call' }>,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(call.name)
  if (!tool) return { success: false, output: '', error: `未找到工具: ${call.name}` }

  // 参数别名归一化（对齐 Qoder 三别名兼容）：不同模型对参数命名习惯不同
  // （tool_name/toolName/name、file_path/filepath/path…），归一化后权限与工具共用
  const args = normalizeArgs(call.arguments)

  // 权限裁决（P5）：deny 结构化拒绝回灌，ask 交人在回路
  if (ctx.permission) {
    const decision = await checkPermission({ name: call.name, args }, {
      cwd: ctx.cwd,
      mode: ctx.permission.mode,
      engine: ctx.permission.engine,
    })
    if (decision.type === 'ask') {
      // 权限请求 hook：弹确认前通知外部（审计/自动决策）
      await ctx.hooks?.fire('permission_request', {
        cwd: ctx.cwd,
        call: { name: call.name, args },
        decision: 'ask',
      })
      if (!ctx.ask) return { success: false, output: '', error: '[权限拒绝] 需要用户确认（无确认通道）' }
      const askResult = await ctx.ask({ name: call.name, args, reason: decision.reason })
      const allowRule: Omit<Rule, 'source'> = { tool: call.name, pattern: patternFor({ ...call, arguments: args }), action: 'allow' }
      if (askResult === 'once') {
        // 对齐 Codex 审批缓存：本次批准也进会话规则——同命令本会话免重复确认
        ctx.permission.engine.addSessionRule(allowRule)
      } else if (askResult === 'session') {
        ctx.permission.engine.addSessionRule(allowRule)
      } else if (askResult === 'forever') {
        ctx.permission.engine.appendProjectRule(allowRule)
      } else {
        return { success: false, output: '', error: '[权限拒绝] 用户拒绝' }
      }
    } else if (decision.type === 'deny') {
      // 权限拒绝 hook：审计记录/通知
      await ctx.hooks?.fire('permission_denied', {
        cwd: ctx.cwd,
        call: { name: call.name, args },
        decision: 'deny',
        reason: decision.reason ?? '',
      })
      return { success: false, output: '', error: `[权限拒绝] ${decision.reason}` }
    }
  }

  // P11：tool_before Hook 拦截（权限裁决之后）
  const blocked = ctx.hooks ? await ctx.hooks.intercept({ name: call.name, args }, ctx.cwd) : null
  if (blocked) return { success: false, output: '', error: blocked }

  try {
    return await tool.execute(args, ctx)
  } catch (e) {
    return { success: false, output: '', error: `工具执行异常: ${(e as Error).message}` }
  }
}

function patternFor(call: Extract<StreamEvent, { type: 'tool_call' }>): string {
  const v = call.arguments.command ?? call.arguments.path ?? call.arguments.pattern
  if (typeof v !== 'string') return '*'
  // 命令规范化：空白归一（rm  -rf x 与 rm -rf x 同一缓存键）；路径不规范化（含空格）
  return call.name === 'run_command' ? v.replace(/\s+/g, ' ').trim() : v
}

// 工具参数别名归一化（对齐 Qoder 三别名兼容）：不同模型对参数命名习惯不同
// （tool_name/toolName/name、file_path/filepath/path…），统一映射到规范名
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
  const out = { ...raw }
  for (const [canonical, aliases] of Object.entries(ARG_ALIASES)) {
    if (out[canonical] !== undefined) continue
    for (const a of aliases) {
      if (out[a] !== undefined) {
        out[canonical] = out[a]
        break
      }
    }
  }
  return out
}
