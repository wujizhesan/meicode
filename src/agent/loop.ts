import type { ChatMessage, StreamEvent } from '../provider/types.ts'
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
import { estimateMessageTokens } from '../context/estimate.ts'
import type { ContextCompactionResult } from '../context/manager.ts'
import { linkAbortSignal } from '../provider/stream.ts'
import { resolveOnAbort } from '../tools/abort.ts'
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
  const linkedAbort = linkAbortSignal(opts.signal)
  const { controller } = linkedAbort
  const toolCtx: ToolContext = { ...ctx, signal: controller.signal }
  const runSessionId = ctx.sessionId
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
    let contextInvalidated = false
    const shouldStop = (contextCheck?: ContextCompactionResult | void): boolean => {
      contextInvalidated ||= ctx.sessionId !== runSessionId
        || (contextCheck !== undefined && (contextCheck.status === 'stale' || (contextCheck.status === 'cancelled' && !controller.signal.aborted)))
      if (contextInvalidated) controller.abort()
      return controller.signal.aborted
    }
    let roundErrorMessage: string | null = null
    let fatalError: string | null = null
    const evidence = new RuntimeEvidenceAccumulator()
    let toolFailStreak = 0
    let compactRetries = 0 // 超限自动压缩重试计数(最多 2 次)
    let injectionRound = 0
    const hookInjections: string[] = []
    const unsentHookLeases: Array<{ commit(): void; rollback(): void }> = []
    const systemInjections: string[] = []
    const unsentSystemInjections: string[] = []
    const repeatedToolCalls = new RepeatedToolCallGuard()

    emitRuntimeEvent(toolCtx, {
      type: 'run_started',
      agentId: toolCtx.agentId,
      payload: { mode, maxIterations },
    })

    // 主 system：稳定前缀（与轮次无关，逐字节一致以命中缓存）
    const systemMain = opts.systemPrompt || buildSystemPrompt(mode)
    try {
    for (round = 1; round <= maxIterations; round++) {
      if (shouldStop()) {
        reason = 'cancelled'
        break
      }
      emit({ type: 'progress', round, max: maxIterations, status: mode === 'plan' ? '计划中' : '执行中' })

      // 同一轮超限重试保留注入，round_start 只触发一次。
      if (injectionRound !== round) {
        injectionRound = round
        hookInjections.length = 0
        systemInjections.length = 0
        await resolveOnAbort(async () => toolCtx.hooks?.fire('round_start', { cwd: toolCtx.cwd, sessionId: toolCtx.sessionId, agentId: toolCtx.agentId, round }, controller.signal), controller.signal, undefined)
      }
      if (shouldStop()) {
        reason = 'cancelled'
        break
      }
      const hookScope = { sessionId: ctx.sessionId, agentId: ctx.agentId }
      const requestOptions = opts.resolveRequestOptions?.()
      const configuredTools = requestOptions?.toolsOverride ?? opts.toolsOverride ?? registry.toOpenAITools()
      const tools = mode === 'plan'
        ? configuredTools.filter((tool) => READ_ONLY_TOOLS.has(tool.function.name))
        : [...configuredTools]
      const allowedTools = new Set(tools.map((tool) => tool.function.name))
      const toolTokens = tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / 4) : 0
      const extraSystemMessages = [...(opts.extraSystemMessages ?? []), ...(requestOptions?.extraSystemMessages ?? [])]

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
        emitRuntimeEvents(toolCtx, pendingToolCallEvents)
        pendingToolCallEvents = []
      }

      const directive = sessionDirective(mode, round)
      const remaining = maxIterations - round
      // 轮次提醒：剩余 ≤3 轮时报告优先——防成员分析占满轮次收尾不完整(实战实锤: jsr/rm 轮尽报告未落盘)
      const endgameHint =
        remaining <= 3 && mode === 'full'
          ? [{ role: 'system' as const, content: `[系统] 剩余 ${remaining} 轮。如果任务需要产出报告（write_paths 契约目录，如 契约目录\\），立即用 write_file 写入——报告优先于继续深入分析。` }]
          : []
      const prefix: ChatMessage[] = [
        { role: 'system', content: systemMain },
        { role: 'system', content: buildEnvironmentInfo(ctx) },
        ...(directive ? [{ role: 'system' as const, content: directive }] : []),
        ...extraSystemMessages.map((content) => ({ role: 'system' as const, content })),
      ]
      const fixedTokens = toolTokens + [...prefix, ...endgameHint].reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      const collectInjections = (): void => {
        const hookLease = ctx.hooks?.checkoutInjections(hookScope)
        if (hookLease?.messages.length) {
          hookInjections.push(...hookLease.messages)
          unsentHookLeases.push(hookLease)
        }
        const collected = opts.injectSystem?.() ?? []
        systemInjections.push(...collected)
        unsentSystemInjections.push(...collected)
      }
      const overheadTokens = (): number => fixedTokens
        + [...hookInjections, ...systemInjections].reduce((sum, content) => sum + estimateMessageTokens({ role: 'system', content }), 0)
      if (ctx.setRequestOverhead) {
        collectInjections()
        ctx.setRequestOverhead(overheadTokens())
      }
      // 压缩 Hook 和等待期间的新回流也进入当前请求及预算。
      const contextCheck = await ctx.beforeRequest?.('auto', controller.signal)
      if (shouldStop(contextCheck)) {
        reason = 'cancelled'
        break
      }
      collectInjections()
      if (opts.persistSystemInjections) {
        for (const content of systemInjections) history.push({ role: 'system', content })
        systemInjections.length = 0
        unsentSystemInjections.length = 0
      }
      const requestOverheadTokens = overheadTokens()
      ctx.setRequestOverhead?.(requestOverheadTokens)

      log('info', `round ${round}/${maxIterations} 请求 model=${opts.systemPrompt ? 'custom' : mode} msgs=${history.length}`)
      const requestHistory = getSanitizedHistory()
      const requestHistoryCount = history.length
      const msgs: ChatMessage[] = [
        ...prefix,
        ...hookInjections.map((c) => ({ role: 'system' as const, content: c })),
        ...endgameHint,
        // P14：请求前 sanitize——任何路径产生的不完整 assistant(tool_calls) 都被过滤（防 DeepSeek 400）
        ...requestHistory,
      ]
      // P12：请求前注入回流结果——追加在末尾（请求时历史是稳定快照，永不插 assistant/tool 中间）
      for (const c of systemInjections) {
        msgs.push({ role: 'system', content: c })
      }

      const contextBudget = ctx.contextBudget?.()
      if (shouldStop()) {
        reason = 'cancelled'
        break
      }
      emitRuntimeEvents(toolCtx, [
        {
          type: 'turn_started',
          agentId: toolCtx.agentId,
          turn: round,
          payload: { mode },
        },
        {
          type: 'context_snapshot',
          agentId: toolCtx.agentId,
          turn: round,
          payload: { ...(contextBudget ?? {}) },
        },
        {
          type: 'model_request',
          agentId: toolCtx.agentId,
          turn: round,
          payload: { messageCount: msgs.length, toolCount: tools.length, contextBudget: { ...(contextBudget ?? {}) } },
        },
      ])

      try {
        for (const lease of unsentHookLeases.splice(0)) lease.commit()
        unsentSystemInjections.length = 0
        for await (const ev of provider.streamChat(msgs, { thinking: false, tools, signal: controller.signal })) {
          if (shouldStop()) break
          if (ev.type !== 'tool_call') flushToolCallEvents()
          if (ev.type === 'text') {
            roundTextParts.push(ev.text)
            emit({ type: 'text', text: ev.text })
          } else if (ev.type === 'thinking') {
            emit({ type: 'thinking', text: ev.text })
          } else if (ev.type === 'tool_call') {
            roundCalls.push(ev)
            emit({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.arguments })
            const argumentSummary = summarizeRuntimeValue(ev.arguments)
            pendingToolCallEvents.push({
              type: 'tool_call',
              agentId: toolCtx.agentId,
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
            if (ev.inputTokens > 0) ctx.afterRequest?.(ev.inputTokens, requestHistoryCount, ctx.setRequestOverhead ? requestOverheadTokens : undefined)
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

      if (shouldStop()) {
        reason = 'cancelled'
        break
      }
      if (roundError) {
        if (/context_(?:length|window)_exceeded|prompt_too_long|maximum context length|(?:context|prompt|input).{0,80}(?:exceed|too (?:long|large))|(?:exceed|too (?:long|large)).{0,80}(?:context|token(?:s| limit)?)|token(?:s| limit)?.{0,80}exceed/is.test(roundError)
          && ctx.beforeRequest && compactRetries < 2) {
          compactRetries++
          const previousTokens = requestHistory.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
          const compaction = await ctx.beforeRequest('manual', controller.signal, { force: true })
          if (shouldStop(compaction)) {
            reason = 'cancelled'
            break
          }
          const currentTokens = getSanitizedHistory().reduce((sum, message) => sum + estimateMessageTokens(message), 0)
          if ((compaction === undefined || compaction.status === 'compacted' || compaction.status === 'skipped')
            && currentTokens < previousTokens) {
            log('info', `上下文超限,压缩后重试(${compactRetries}/2): ${roundError.slice(0, 120)}`)
            round--
            continue
          }
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
      if (allowedTools.has('spawn_agent')) {
        toolCtx.forkContext = {
          history: structuredClone(requestHistory.slice(-10)),
          tools: tools.flatMap((schema) => {
            const tool = registry.get(schema.function.name)
            return tool ? [tool] : []
          }),
        }
      } else delete toolCtx.forkContext
      const executed = await executeToolBatch(roundCalls, registry, toolCtx, async (call, result) => {
        shouldStop()
        if (contextInvalidated) return
        evidence.add(result.evidence)
        // P11：tool_after Hook
        if (!controller.signal.aborted) {
          await resolveOnAbort(async () => toolCtx.hooks?.fire('tool_after', { cwd: toolCtx.cwd, sessionId: toolCtx.sessionId, agentId: toolCtx.agentId, call: { name: call.name, args: call.arguments } }, controller.signal), controller.signal, undefined)
        }
        shouldStop()
        if (contextInvalidated) return
        log('info', `tool ${call.name} ${result.success ? 'ok' : 'fail'}${result.error ? `: ${result.error.slice(0, 120)}` : ''}`)
        toolResultEvents.push({
          type: 'tool_result',
          agentId: toolCtx.agentId,
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
          ...(result.diff ? { diff: result.diff } : {}),
          ...(result.output ? { output: result.output } : {}),
        })
      }, () => !shouldStop(), allowedTools)
      emitRuntimeEvents(toolCtx, toolResultEvents)
      shouldStop()
      if (contextInvalidated) {
        reason = 'cancelled'
        break
      }
      // 连续工具失败止损：≥3 轮全失败停止（防模型死磕烧 token）
      toolFailStreak = nextToolFailureStreak(executed.map(({ result }) => result.success), toolFailStreak)
      const stopEarly = !controller.signal.aborted && toolFailStreak >= 3
      if (stopEarly) {
        reason = 'tool_failures'
        roundErrorMessage = '工具连续失败 3 轮，已停止（建议检查环境或换一种方式）'
      }

      // P7：大工具结果存盘（轻量预防）——回灌前处理；失败降级为原样保留，不阻塞主流程
      let spillResults = executed.map(({ result }) => ({ content: result.success ? result.output : `[失败] ${result.error}` }))
      if (toolCtx.spill && !controller.signal.aborted) {
        try {
          spillResults = await toolCtx.spill(spillResults)
        } catch (e) {
          console.warn(`[上下文] 存盘失败（降级原样保留）: ${(e as Error).message}`)
        }
      }
      shouldStop()
      if (contextInvalidated) {
        reason = 'cancelled'
        break
      }
      for (let i = 0; i < executed.length; i++) {
        history.push({
          role: 'tool',
          tool_call_id: executed[i].call.id,
          content: spillResults[i].content,
        })
      }
      if (controller.signal.aborted) {
        reason = 'cancelled'
        break
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
      if (shouldStop()) {
        reason = 'cancelled'
      } else {
        fatalError = `Agent 循环异常: ${(e as Error).message}`
        reason = 'error'
        log('error', `agent loop fatal: ${(e as Error).message}`)
      }
    }
    if (shouldStop()) reason = 'cancelled'
    for (let index = unsentHookLeases.length - 1; index >= 0; index--) {
      if (contextInvalidated) unsentHookLeases[index]!.commit()
      else unsentHookLeases[index]!.rollback()
    }
    if (!contextInvalidated && unsentSystemInjections.length > 0) {
      try {
        opts.restoreUnsentSystem?.(unsentSystemInjections)
      } catch (e) {
        log('error', `恢复未发送回流失败: ${(e as Error).message}`)
      }
    }
    if (shouldStop()) reason = 'cancelled'
    else if (round > maxIterations) reason = 'max_iterations'
    log('info', `agent 结束 reason=${reason} rounds=${Math.min(round, maxIterations)} tokens=${totalTokens}`)
    // P11：round_end 注入保留到同一 Agent 的下一次运行
    if (!contextInvalidated) {
      try {
        await resolveOnAbort(async () => toolCtx.hooks?.fire('round_end', { cwd: toolCtx.cwd, sessionId: toolCtx.sessionId, agentId: toolCtx.agentId, round: Math.min(round, maxIterations) }, controller.signal), controller.signal, undefined)
      } catch {
        // 忽略
      }
    }
    if (shouldStop()) reason = 'cancelled'
    if (contextInvalidated) finalText = ''
    const errorMessage = fatalError ?? roundErrorMessage ?? undefined
    emitRuntimeEvent(toolCtx, {
      type: 'run_finished',
      agentId: toolCtx.agentId,
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
  })().finally(linkedAbort.dispose)

  return {
    events,
    cancel: () => controller.abort(),
    done: donePromise,
  }
}
