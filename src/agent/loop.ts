import type { ChatMessage, Provider, StreamEvent } from '../provider/types.ts'
import type { History } from '../session/history.ts'
import { sanitizeMessages } from '../memory/session.ts'
import { log } from '../log.ts'
import type { ToolContext } from '../tools/index.ts'
import type { AgentEvent, AgentHandle, AgentOptions, AgentResult, StopReason } from './events.ts'
import { buildSystemPrompt, buildEnvironmentInfo, sessionDirective } from './prompt/index.ts'
import type { RuntimeEventInput } from '../runtime/index.ts'
import { RuntimeEvidenceAccumulator } from '../runtime/index.ts'
import { nextToolFailureStreak, nextUnknownToolStreak, READ_ONLY_TOOLS, RepeatedToolCallGuard } from './loop-guards.ts'
import { summarizeRuntimeValue } from './runtime-summary.ts'
import { executeToolBatch } from './tool-execution.ts'
export { normalizeArgs } from './tool-execution.ts'

function emitRuntimeEvent(ctx: ToolContext, input: Omit<RuntimeEventInput, 'sessionId'>): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.append({ ...input, sessionId })
  } catch {
  }
}

function emitRuntimeEvents(ctx: ToolContext, inputs: readonly Omit<RuntimeEventInput, 'sessionId'>[]): void {
  const sessionId = ctx.sessionId ?? ctx.agentId
  if (!ctx.runtimeEvents || !sessionId) return
  try {
    ctx.runtimeEvents.appendBatch(inputs.map((input) => ({ ...input, sessionId })))
  } catch {
  }
}

export function runAgent(opts: AgentOptions): AgentHandle {
  const { provider, history, registry, ctx, maxIterations, mode, unknownToolLimit } = opts
  const controller = new AbortController()
  const toolCtx: ToolContext = { ...ctx, signal: controller.signal }
  let sanitizedHistory: ChatMessage[] = []
  let sanitizedSourceLength = 0
  let sanitizedVersion = -1
  let sanitizedStructureVersion = -1
  let sanitizedSourceValid = true

  const getSanitizedHistory = (): readonly ChatMessage[] => {
    if (sanitizedVersion === history.version) return sanitizedHistory
    const source = history.view()
    if (sanitizedStructureVersion !== history.structureVersion || !sanitizedSourceValid || source.length < sanitizedSourceLength) {
      sanitizedHistory = sanitizeMessages(source)
    } else if (source.length > sanitizedSourceLength) {
      sanitizedHistory.push(...sanitizeMessages(source.slice(sanitizedSourceLength)))
    }
    sanitizedSourceLength = source.length
    sanitizedSourceValid = sanitizedHistory.length === source.length
    sanitizedVersion = history.version
    sanitizedStructureVersion = history.structureVersion
    return sanitizedHistory
  }

  // ---------- 事件流 ----------
  const eventQueue: AgentEvent[] = []
  let eventHead = 0
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
        if (eventHead < eventQueue.length) {
          const event = eventQueue[eventHead++]!
          if (eventHead >= 1024 && eventHead * 2 >= eventQueue.length) {
            eventQueue.splice(0, eventHead)
            eventHead = 0
          }
          yield event
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
    const evidence = new RuntimeEvidenceAccumulator()
    let toolFailStreak = 0
    let compactRetries = 0 // 超限自动压缩重试计数(最多 2 次)
    const repeatedToolCalls = new RepeatedToolCallGuard()

    emitRuntimeEvent(ctx, {
      type: 'run_started',
      agentId: ctx.agentId,
      payload: { mode, maxIterations },
    })

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
      await ctx.hooks?.fire('round_start', { cwd: ctx.cwd, sessionId: ctx.sessionId, agentId: ctx.agentId, round })
      const hookScope = { sessionId: ctx.sessionId, agentId: ctx.agentId }

      const roundCalls: Extract<StreamEvent, { type: 'tool_call' }>[] = []
      const serializedArguments = new Map<Extract<StreamEvent, { type: 'tool_call' }>, string>()
      const serializeArguments = (call: Extract<StreamEvent, { type: 'tool_call' }>): string => {
        const cached = serializedArguments.get(call)
        if (cached !== undefined) return cached
        const serialized = JSON.stringify(call.arguments)
        serializedArguments.set(call, serialized)
        return serialized
      }
      let pendingToolCallEvents: Omit<RuntimeEventInput, 'sessionId'>[] = []
      const roundTextParts: string[] = []
      let roundError: string | null = null
      const flushToolCallEvents = (): void => {
        if (pendingToolCallEvents.length === 0) return
        emitRuntimeEvents(ctx, pendingToolCallEvents)
        pendingToolCallEvents = []
      }

      // P7：请求前上下文检查（轻量预防 + 重量兜底）
      await ctx.beforeRequest?.('auto')
      const hookInjections = ctx.hooks?.collectInjections(hookScope) ?? []

      log('info', `round ${round}/${maxIterations} 请求 model=${opts.systemPrompt ? 'custom' : mode} msgs=${history.length}`)
      const directive = sessionDirective(mode, round)
      const remaining = maxIterations - round
      // 轮次提醒：剩余 ≤3 轮时报告优先——防成员分析占满轮次收尾不完整(实战实锤: jsr/rm 轮尽报告未落盘)
      const endgameHint =
        remaining <= 3
          ? [{ role: 'system' as const, content: `[系统] 剩余 ${remaining} 轮。如果任务需要产出报告（write_paths 契约目录，如 契约目录\\），立即用 write_file 写入——报告优先于继续深入分析。` }]
          : []
      const msgs: ChatMessage[] = [
        { role: 'system', content: systemMain },
        { role: 'system', content: buildEnvironmentInfo(ctx) },
        ...(directive ? [{ role: 'system' as const, content: directive }] : []),
        ...(opts.extraSystemMessages?.map((c) => ({ role: 'system' as const, content: c })) ?? []),
        ...hookInjections.map((c) => ({ role: 'system' as const, content: c })),
        ...endgameHint,
        // P14：请求前 sanitize——任何路径产生的不完整 assistant(tool_calls) 都被过滤（防 DeepSeek 400）
        ...getSanitizedHistory(),
      ]
      // P12：请求前注入回流结果——追加在末尾（请求时历史是稳定快照，永不插 assistant/tool 中间）
      for (const c of opts.injectSystem?.() ?? []) {
        msgs.push({ role: 'system', content: c })
      }

      const contextBudget = ctx.contextBudget?.()
      emitRuntimeEvents(ctx, [
        {
          type: 'turn_started',
          agentId: ctx.agentId,
          turn: round,
          payload: { mode },
        },
        {
          type: 'context_snapshot',
          agentId: ctx.agentId,
          turn: round,
          payload: { ...(contextBudget ?? {}) },
        },
        {
          type: 'model_request',
          agentId: ctx.agentId,
          turn: round,
          payload: { messageCount: msgs.length, toolCount: tools.length, contextBudget: { ...(contextBudget ?? {}) } },
        },
      ])

      try {
        for await (const ev of provider.streamChat(msgs, { thinking: false, tools, signal: controller.signal })) {
          if (controller.signal.aborted) break
          if (ev.type !== 'tool_call') flushToolCallEvents()
          if (ev.type === 'text') {
            roundTextParts.push(ev.text)
            emit({ type: 'text', text: ev.text })
          } else if (ev.type === 'thinking') {
            emit({ type: 'thinking', text: ev.text })
          } else if (ev.type === 'tool_call') {
            roundCalls.push(ev)
            const argumentSummary = summarizeRuntimeValue(ev.arguments)
            pendingToolCallEvents.push({
              type: 'tool_call',
              agentId: ctx.agentId,
              turn: round,
              correlationId: ev.id,
              payload: {
                name: ev.name,
                arguments: argumentSummary.value,
                ...(argumentSummary.truncated ? { argumentsTruncated: true } : {}),
              },
            })
          } else if (ev.type === 'usage') {
            totalTokens += ev.inputTokens + ev.outputTokens
            if (ev.inputTokens > 0) ctx.afterRequest?.(ev.inputTokens, history.length)
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
      } finally {
        flushToolCallEvents()
      }

      const roundText = roundTextParts.join('')

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

      if (new Set(roundCalls.map((call) => call.id)).size !== roundCalls.length) {
        reason = 'error'
        roundErrorMessage = '模型返回了重复的工具调用 ID，已拒绝执行该轮工具'
        break
      }

      unknownStreak = nextUnknownToolStreak(roundCalls, (name) => !!registry.get(name), unknownStreak)

      // 重复工具调用检测:同一签名(工具+参数)窗口内 ≥N 次 → 停止(防死循环烧 token)
      // 未知工具跳过(走 unknownStreak);查询类工具豁免——轮询状态是合法行为
      // 写类工具严格(3 次即停,写死循环代价高);run_command 等放宽(5):调研命令密集合法(实战误伤)
      const repeated = repeatedToolCalls.inspect(roundCalls, (name) => !!registry.get(name), serializeArguments)
      if (repeated) {
        roundErrorMessage = `重复调用工具 ${repeated.name} ${repeated.count} 次(相同参数),已停止——换个方式或询问用户`
        log('info', `重复工具调用 ${repeated.name} ×${repeated.count},停止`)
        reason = 'tool_repeat'
        break
      }

      history.push({
        role: 'assistant',
        content: roundText,
        tool_calls: roundCalls.map((c) => ({ id: c.id, name: c.name, arguments: serializeArguments(c) })),
      })

      const toolResultEvents: Omit<RuntimeEventInput, 'sessionId'>[] = []
      const executed = await executeToolBatch(roundCalls, registry, toolCtx, async (call, result) => {
        evidence.add(result.evidence)
        // P11：tool_after Hook
        await ctx.hooks?.fire('tool_after', { cwd: ctx.cwd, sessionId: ctx.sessionId, agentId: ctx.agentId, call: { name: call.name, args: call.arguments } })
        log('info', `tool ${call.name} ${result.success ? 'ok' : 'fail'}${result.error ? `: ${result.error.slice(0, 120)}` : ''}`)
        toolResultEvents.push({
          type: 'tool_result',
          agentId: ctx.agentId,
          turn: round,
          correlationId: call.id,
          payload: { name: call.name, success: result.success, truncated: result.truncated, error: result.error, evidence: result.evidence },
        })
        emit({
          type: 'tool_result',
          id: call.id,
          name: call.name,
          success: result.success,
          summary: result.success ? (result.truncated ? '成功（结果已截断）' : '成功') : (result.error ?? '失败'),
        })
      })
      emitRuntimeEvents(ctx, toolResultEvents)
      // 连续工具失败止损：≥3 轮全失败停止（防模型死磕烧 token）
      toolFailStreak = nextToolFailureStreak(executed.map(({ result }) => result.success), toolFailStreak)
      const stopEarly = toolFailStreak >= 3
      if (stopEarly) {
        reason = 'tool_failures'
        roundErrorMessage = '工具连续失败 3 轮，已停止（建议检查环境或换一种方式）'
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
    if (round > maxIterations) reason = 'max_iterations'
    log('info', `agent 结束 reason=${reason} rounds=${Math.min(round, maxIterations)} tokens=${totalTokens}`)
    // P11：round_end 注入保留到同一 Agent 的下一次运行
    try {
      await ctx.hooks?.fire('round_end', { cwd: ctx.cwd, sessionId: ctx.sessionId, agentId: ctx.agentId, round: Math.min(round, maxIterations) })
    } catch {
      // 忽略
    }
    const errorMessage = fatalError ?? roundErrorMessage ?? undefined
    emitRuntimeEvent(ctx, {
      type: 'run_finished',
      agentId: ctx.agentId,
      payload: { reason, rounds: Math.min(round, maxIterations), totalTokens, error: errorMessage },
    })
    emit({
      type: 'done',
      reason,
      rounds: Math.min(round, maxIterations),
      totalTokens,
      ...(errorMessage ? { errorMessage } : {}),
    })
    return { reason, rounds: Math.min(round, maxIterations), totalTokens, finalText, evidence: evidence.snapshot(), ...(errorMessage ? { errorMessage } : {}) }
  })()

  return {
    events,
    cancel: () => controller.abort(),
    done: donePromise,
  }
}
