import assert from 'node:assert/strict'
import { runAgent } from '../src/agent/loop.ts'
import type { AgentHandle } from '../src/agent/events.ts'
import { estimateMessageTokens } from '../src/context/estimate.ts'
import { ContextManager } from '../src/context/manager.ts'
import { SUMMARY_SYSTEM } from '../src/context/summary.ts'
import { HookEngine } from '../src/hook/engine.ts'
import type { HookRule } from '../src/hook/types.ts'
import { RuleEngine } from '../src/permission/rules.ts'
import type { ChatMessage, Provider, StreamChatOptions, StreamEvent } from '../src/provider/types.ts'
import { createAgentRuntimeContext } from '../src/runtime/agent-context.ts'
import type { RuntimeEventInput } from '../src/runtime/events.ts'
import { History } from '../src/session/history.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolContext } from '../src/tools/types.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('恢复请求未及时结束')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function historyFixture(count = 20): History {
  const history = new History()
  for (let index = 0; index < count; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}:` + 'x'.repeat(600 - `${index}:`.length) })
  return history
}

class OverflowProvider implements Provider {
  readonly protocol = 'openai' as const
  summaryRequests = 0
  mainInputs: number[] = []
  mainMessages: ChatMessage[][] = []
  summaryText = '早期历史摘要'
  summaryError: string | undefined
  errorMessage = 'maximum context length exceeded'
  alwaysOverflow = false
  inputOverhead = 0
  onSummary: ((options: StreamChatOptions) => Promise<void>) | undefined
  onMain: ((index: number) => StreamEvent[]) | undefined

  async *streamChat(messages: ChatMessage[], options: StreamChatOptions): AsyncGenerator<StreamEvent> {
    if (messages[0]?.content === SUMMARY_SYSTEM) {
      this.summaryRequests++
      await this.onSummary?.(options)
      if (this.summaryError) yield { type: 'error', message: this.summaryError }
      else yield { type: 'text', text: this.summaryText }
    } else {
      const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + this.inputOverhead
      this.mainInputs.push(tokens)
      this.mainMessages.push([...messages])
      if (tokens > 8192 || this.alwaysOverflow) yield { type: 'error', message: this.errorMessage }
      else if (this.onMain) yield* this.onMain(this.mainMessages.length - 1)
      else yield { type: 'text', text: '任务继续' }
    }
    yield { type: 'done' }
  }
}

function startAgent(provider: OverflowProvider, history: History, ctx: ToolContext, maxIterations = 10): AgentHandle {
  provider.inputOverhead = 3000
  return runAgent({ provider, history, ctx, registry: new ToolRegistry(), maxIterations, mode: 'full', unknownToolLimit: 2, systemPrompt: '本地超限恢复', extraSystemMessages: ['r'.repeat(12000)] })
}

function runtimeContext(provider: Provider, history: History) {
  return createAgentRuntimeContext({ provider, history, cwd: process.cwd(), contextWindow: 8192, engine: new RuleEngine('unused-user', 'unused-project', 'unused-local') })
}

const returnedReport = '[子任务采集结果] 关键订单编号 ORDER-42'
const onceHint = '本轮一次性提示：必须核对 ORDER-42'

function injectionFixture(once = true, extraHooks: HookRule[] = []) {
  const history = historyFixture()
  const provider = new OverflowProvider()
  const hooks = new HookEngine([{ event: 'round_start', once, action: { type: 'inject_prompt', content: onceHint } }, ...extraHooks])
  const roundStarts: number[] = []
  const fire = hooks.fire.bind(hooks)
  hooks.fire = async (event, scope) => {
    if (event === 'round_start') roundStarts.push(scope.round!)
    await fire(event, scope)
  }
  const manager = new ContextManager({ provider, history, hooks, cwd: process.cwd(), window: 8192, sessionId: 'injection-session', agentId: 'injection-agent' })
  const ctx: ToolContext = {
    cwd: process.cwd(), hooks, sessionId: 'injection-session', agentId: 'injection-agent',
    beforeRequest: (mode, signal, options) => manager.beforeRequest(mode, signal, options),
    afterRequest: (usage, count) => manager.afterRequest(usage, count),
    contextBudget: () => manager.snapshot(),
  }
  const pending = [returnedReport]
  const opts = {
    provider, history, ctx, registry: new ToolRegistry(), maxIterations: 1, mode: 'full' as const,
    unknownToolLimit: 2, systemPrompt: '本地注入重试', extraSystemMessages: ['r'.repeat(22000)],
    injectSystem: () => pending.splice(0, pending.length),
  }
  return { history, provider, hooks, ctx, pending, opts, roundStarts }
}

function occurrences(messages: readonly ChatMessage[], content: string): number {
  return messages.filter((message) => message.content === content).length
}

for (const maxIterations of [10, 1]) {
  await check(`8K 冷启动估算偏低时强制摘要并恢复，maxIterations=${maxIterations}`, async () => {
    const history = historyFixture()
    const recent = history.all().slice(-6)
    const provider = new OverflowProvider()
    const ctx = runtimeContext(provider, history)
    assert.equal(ctx.contextBudget!().estimatedTokens, 3000)
    const agent = startAgent(provider, history, ctx, maxIterations)
    const result = await bounded(agent.done)
    const events = []
    for await (const event of agent.events) events.push(event)
    assert.equal(result.reason, 'complete')
    assert.equal(result.rounds, 1)
    assert.equal(provider.summaryRequests, 1)
    assert.equal(provider.mainInputs.length, 2)
    assert(provider.mainInputs[0] > 8192 && provider.mainInputs[1] < 8192)
    assert.deepEqual(history.view().slice(2, 8), recent)
    assert.equal(events.filter((event) => event.type === 'done').length, 1)
    assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), ['任务继续'])
  })
}

await check('普通手动压缩仍遵循阈值，force 可摘要未超阈值的历史', async () => {
  const history = historyFixture()
  const provider = new OverflowProvider()
  const manager = new ContextManager({ provider, history, cwd: process.cwd(), window: 8192 })
  assert.deepEqual(await manager.compact(), { status: 'skipped', reason: 'below_threshold' })
  const result = await manager.beforeRequest('manual', undefined, { force: true })
  assert.equal(result?.status, 'compacted')
  assert.equal(provider.summaryRequests, 1)
  assert(manager.snapshot().estimatedTokens < 3000)
})

await check('强制请求等待普通检查后升级，多个强制请求共享一次摘要', async () => {
  const history = historyFixture()
  const provider = new OverflowProvider()
  const manager = new ContextManager({ provider, history, cwd: process.cwd(), window: 8192 })
  const normal = manager.beforeRequest('manual')
  const forced = [manager.beforeRequest('manual', undefined, { force: true }), manager.beforeRequest('manual', undefined, { force: true })]
  assert.equal((await bounded(normal))?.status, 'skipped')
  const results = await bounded(Promise.all(forced))
  assert(results.every((result) => result?.status === 'compacted'))
  assert.equal(provider.summaryRequests, 1)
})

await check('摘要失败时保留原始超限错误，不重发相同历史', async () => {
  const history = historyFixture()
  const original = history.all()
  const provider = new OverflowProvider()
  provider.summaryError = '摘要请求失败'
  const result = await bounded(startAgent(provider, history, runtimeContext(provider, history)).done)
  assert.equal(result.reason, 'error')
  assert.equal(result.errorMessage, provider.errorMessage)
  assert.equal(provider.mainInputs.length, 1)
  assert.equal(provider.summaryRequests, 1)
  assert.deepEqual(history.view(), original)
})

await check('没有可摘要的早期历史时停止，不消耗重复主请求', async () => {
  const history = historyFixture(5)
  const provider = new OverflowProvider()
  provider.alwaysOverflow = true
  const result = await bounded(startAgent(provider, history, runtimeContext(provider, history), 1).done)
  assert.equal(result.reason, 'error')
  assert.equal(provider.mainInputs.length, 1)
  assert.equal(provider.summaryRequests, 0)
  assert.equal(history.length, 5)
})

await check('摘要反而变长时保留原历史且不继续重试', async () => {
  const history = historyFixture()
  const original = history.all()
  const version = history.version
  const structureVersion = history.structureVersion
  const provider = new OverflowProvider()
  provider.summaryText = 's'.repeat(16000)
  const result = await bounded(startAgent(provider, history, runtimeContext(provider, history)).done)
  assert.equal(result.reason, 'error')
  assert.equal(result.errorMessage, provider.errorMessage)
  assert.equal(provider.mainInputs.length, 1)
  assert.equal(provider.summaryRequests, 1)
  assert.deepEqual(history.view(), original)
  assert.equal(history.version, version)
  assert.equal(history.structureVersion, structureVersion)
})

await check('内容完全相同但版本改变的回调不视为压缩进展', async () => {
  const history = historyFixture()
  const original = history.all()
  const provider = new OverflowProvider()
  const result = await bounded(startAgent(provider, history, {
    cwd: process.cwd(),
    beforeRequest: async (mode) => {
      if (mode === 'manual') history.replaceRange(0, history.length, original)
    },
  }).done)
  assert.equal(result.reason, 'error')
  assert.equal(provider.mainInputs.length, 1)
})

await check('恢复期间会话重置时，不把新会话历史发给旧任务', async () => {
  const history = historyFixture()
  const provider = new OverflowProvider()
  const hooks = new HookEngine([])
  const manager = new ContextManager({ provider, history, hooks, cwd: process.cwd(), window: 8192 })
  hooks.fire = async (event) => {
    if (event === 'pre_compact') {
      history.clear()
      manager.reset()
      history.push({ role: 'user', content: '新会话' })
    }
  }
  const result = await bounded(startAgent(provider, history, {
    cwd: process.cwd(),
    beforeRequest: (mode, signal, options) => manager.beforeRequest(mode, signal, options),
  }).done)
  assert.equal(result.reason, 'cancelled')
  assert.equal(provider.mainInputs.length, 1)
  assert.equal(provider.summaryRequests, 0)
  assert.deepEqual(history.view(), [{ role: 'user', content: '新会话' }])
})

await check('自动摘要期间切换会话时，旧任务停止且不转移回流、Hook 与结束事件', async () => {
  const history = historyFixture()
  const provider = new OverflowProvider()
  const started = deferred()
  const gate = deferred()
  provider.onSummary = async () => { started.resolve(); await gate.promise }
  const hooks = new HookEngine([
    { event: 'round_start', once: true, action: { type: 'inject_prompt', content: onceHint } },
    { event: 'round_end', action: { type: 'inject_prompt', content: '旧任务结束提示' } },
  ])
  const manager = new ContextManager({ provider, history, hooks, cwd: process.cwd(), window: 8192, sessionId: 'old-session', agentId: 'shared-agent' })
  const runtimeRecords: Array<Pick<RuntimeEventInput, 'type' | 'sessionId'>> = []
  const record = (input: RuntimeEventInput) => { runtimeRecords.push({ type: input.type, sessionId: input.sessionId }) }
  const pending = [returnedReport]
  const restored: string[] = []
  const ctx: ToolContext = {
    cwd: process.cwd(), hooks, sessionId: 'old-session', agentId: 'shared-agent',
    runtimeEvents: { append: record, appendBatch: (inputs: readonly RuntimeEventInput[]) => inputs.forEach(record) } as unknown as ToolContext['runtimeEvents'],
    setRequestOverhead: (tokens) => manager.setRequestOverhead(tokens),
    beforeRequest: (mode, signal, options) => manager.beforeRequest(mode, signal, options),
    contextBudget: () => manager.snapshot(),
  }
  const agent = runAgent({
    provider, history, ctx, registry: new ToolRegistry(), maxIterations: 1, mode: 'full', unknownToolLimit: 2,
    systemPrompt: '旧会话任务', extraSystemMessages: ['r'.repeat(22000)],
    injectSystem: () => pending.splice(0),
    restoreUnsentSystem: (messages) => restored.push(...messages),
  })
  try {
    await bounded(started.promise)
    history.clear()
    manager.reset()
    manager.setSessionId('new-session')
    ctx.sessionId = 'new-session'
    history.push({ role: 'user', content: '新会话专属内容' })
    const result = await bounded(agent.done)
    assert.equal(result.reason, 'cancelled')
    assert.equal(provider.summaryRequests, 1)
    assert.equal(provider.mainMessages.length, 0)
    assert.deepEqual(history.view(), [{ role: 'user', content: '新会话专属内容' }])
    assert.deepEqual(restored, [])
    assert.deepEqual(hooks.collectInjections({ sessionId: 'new-session', agentId: 'shared-agent' }), [])
    assert.deepEqual(hooks.collectInjections({ sessionId: 'old-session', agentId: 'shared-agent' }), [])
    assert.deepEqual(runtimeRecords.filter((event) => event.type === 'run_finished'), [{ type: 'run_finished', sessionId: 'old-session' }])
    assert(!runtimeRecords.some((event) => event.type === 'model_request'))
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('自动摘要检查独立取消时，不继续发送主请求', async () => {
  const history = historyFixture(1)
  const provider = new OverflowProvider()
  const result = await bounded(runAgent({
    provider, history, ctx: { cwd: process.cwd(), beforeRequest: async () => ({ status: 'cancelled' }) },
    registry: new ToolRegistry(), maxIterations: 1, mode: 'full', unknownToolLimit: 2, systemPrompt: '自动摘要检查',
  }).done)
  assert.equal(result.reason, 'cancelled')
  assert.equal(provider.mainMessages.length, 0)
})

await check('最后一轮强制恢复期间可取消，取消后不发重试请求', async () => {
  const history = historyFixture()
  const original = history.all()
  const provider = new OverflowProvider()
  const waiting = deferred()
  const gate = deferred()
  let summarySignal: AbortSignal | undefined
  provider.onSummary = async (options) => {
    summarySignal = options.signal
    waiting.resolve()
    await gate.promise
  }
  const agent = startAgent(provider, history, runtimeContext(provider, history), 1)
  try {
    await bounded(waiting.promise)
    agent.cancel()
    const result = await bounded(agent.done)
    assert.equal(result.reason, 'cancelled')
    assert(summarySignal?.aborted)
    assert.equal(provider.mainInputs.length, 1)
    assert.equal(provider.summaryRequests, 1)
    assert.deepEqual(history.view(), original)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('成功缩短历史仍不能恢复时，最多尝试两次摘要', async () => {
  const history = historyFixture()
  const provider = new OverflowProvider()
  provider.alwaysOverflow = true
  provider.onSummary = async () => { provider.summaryText = provider.summaryRequests === 1 ? 's'.repeat(1800) : '简短摘要' }
  const result = await bounded(startAgent(provider, history, runtimeContext(provider, history), 1).done)
  assert.equal(result.reason, 'error')
  assert.equal(result.rounds, 1)
  assert.equal(provider.mainInputs.length, 3)
  assert.equal(provider.summaryRequests, 2)
  assert(provider.mainInputs[0] > provider.mainInputs[1] && provider.mainInputs[1] > provider.mainInputs[2])
})

await check('最后一轮超限重试保留子任务结果及一次性 Hook 提示', async () => {
  const { history, provider, pending, opts, roundStarts } = injectionFixture()
  const result = await bounded(runAgent(opts).done)
  assert.equal(result.reason, 'complete')
  assert.equal(result.rounds, 1)
  assert.equal(provider.summaryRequests, 1)
  assert.equal(provider.mainMessages.length, 2)
  assert(provider.mainInputs[0] > 8192 && provider.mainInputs[1] < 8192)
  for (const messages of provider.mainMessages) {
    assert.equal(occurrences(messages, returnedReport), 1)
    assert.equal(occurrences(messages, onceHint), 1)
    assert.equal(messages.at(-1)?.content, returnedReport)
  }
  assert.deepEqual(roundStarts, [1])
  assert.equal(pending.length, 0)
  assert(!history.view().some((message) => message.content === returnedReport || message.content === onceHint))
})

await check('重试合并压缩期间新到达的回流及 Hook 消息，保留原有顺序', async () => {
  const newReport = '[子任务校验结果] ORDER-42 已核验'
  const preHint = '压缩前的新提示'
  const postHint = '压缩后的新提示'
  const { provider, pending, opts } = injectionFixture(true, [
    { event: 'pre_compact', action: { type: 'inject_prompt', content: preHint } },
    { event: 'post_compact', action: { type: 'inject_prompt', content: postHint } },
  ])
  provider.onSummary = async () => { pending.push(newReport) }
  const result = await bounded(runAgent(opts).done)
  assert.equal(result.reason, 'complete')
  assert.equal(provider.mainMessages.length, 2)
  assert.equal(occurrences(provider.mainMessages[0], newReport), 0)
  assert.equal(occurrences(provider.mainMessages[0], preHint), 0)
  assert.equal(occurrences(provider.mainMessages[0], postHint), 0)
  const retry = provider.mainMessages[1]
  for (const content of [returnedReport, onceHint, newReport, preHint, postHint]) assert.equal(occurrences(retry, content), 1)
  assert(retry.findIndex((message) => message.content === onceHint) < retry.findIndex((message) => message.content === preHint))
  assert(retry.findIndex((message) => message.content === preHint) < retry.findIndex((message) => message.content === postHint))
  assert.deepEqual(retry.slice(-2).map((message) => message.content), [returnedReport, newReport])
})

await check('两次超限重试保留完整注入，每次新增回流只出现一次且 round_start 不重复', async () => {
  const { provider, pending, opts, roundStarts } = injectionFixture(false)
  provider.alwaysOverflow = true
  provider.onSummary = async () => {
    provider.summaryText = provider.summaryRequests === 1 ? 's'.repeat(1800) : '简短摘要'
    pending.push(`第 ${provider.summaryRequests} 次压缩期间的新回流`)
    if (provider.summaryRequests === 2) provider.alwaysOverflow = false
  }
  const result = await bounded(runAgent(opts).done)
  assert.equal(result.reason, 'complete')
  assert.equal(result.rounds, 1)
  assert.equal(provider.summaryRequests, 2)
  assert.equal(provider.mainMessages.length, 3)
  for (const messages of provider.mainMessages) {
    assert.equal(occurrences(messages, returnedReport), 1)
    assert.equal(occurrences(messages, onceHint), 1)
  }
  assert.deepEqual(provider.mainMessages[2].slice(-3).map((message) => message.content), [returnedReport, '第 1 次压缩期间的新回流', '第 2 次压缩期间的新回流'])
  assert.deepEqual(roundStarts, [1])
})

await check('重试成功并执行工具后，下一轮不重复旧回流且工具组完整', async () => {
  const { history, provider, opts, roundStarts } = injectionFixture(false)
  let executions = 0
  opts.registry.register({
    name: 'probe', description: '本地探针', parameters: { type: 'object', properties: {} },
    async execute() { executions++; return { success: true, output: '探针结果' } },
  })
  provider.onMain = (index) => index === 1
    ? [{ type: 'tool_call', id: 'probe-1', name: 'probe', arguments: {} }]
    : [{ type: 'text', text: '完成' }]
  const result = await bounded(runAgent({ ...opts, maxIterations: 2 }).done)
  assert.equal(result.reason, 'complete')
  assert.equal(result.rounds, 2)
  assert.equal(executions, 1)
  assert.equal(provider.mainMessages.length, 3)
  assert.deepEqual(provider.mainMessages.map((messages) => occurrences(messages, returnedReport)), [1, 1, 0])
  assert.deepEqual(provider.mainMessages.map((messages) => occurrences(messages, onceHint)), [1, 1, 1])
  assert.deepEqual(roundStarts, [1, 2])
  const next = provider.mainMessages[2]
  const callIndex = next.findIndex((message) => message.tool_calls?.[0].id === 'probe-1')
  assert(callIndex >= 0)
  assert.equal(next[callIndex + 1].role, 'tool')
  assert.equal(next[callIndex + 1].tool_call_id, 'probe-1')
  assert.equal(history.view().at(-1)?.content, '完成')
})

await check('团队等待进入下一轮时清空已消费的旧注入', async () => {
  const { provider, opts, roundStarts } = injectionFixture(false)
  let checks = 0
  const result = await bounded(runAgent({ ...opts, maxIterations: 2, teamBusy: () => ++checks === 1 }).done)
  assert.equal(result.reason, 'complete')
  assert.equal(result.rounds, 2)
  assert.equal(provider.mainMessages.length, 3)
  assert.deepEqual(provider.mainMessages.map((messages) => occurrences(messages, returnedReport)), [1, 1, 0])
  assert.deepEqual(provider.mainMessages.map((messages) => occurrences(messages, onceHint)), [1, 1, 1])
  assert.deepEqual(roundStarts, [1, 2])
})

await check('取消摘要不发送重试，缓存不泄漏到下一次运行', async () => {
  const { provider, pending, opts } = injectionFixture()
  const started = deferred()
  const gate = deferred()
  let summarySignal: AbortSignal | undefined
  provider.onSummary = async (options) => { summarySignal = options.signal; started.resolve(); await gate.promise }
  const agent = runAgent(opts)
  try {
    await bounded(started.promise)
    agent.cancel()
    assert.equal((await bounded(agent.done)).reason, 'cancelled')
    assert(summarySignal?.aborted)
    assert.equal(provider.mainMessages.length, 1)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  const newReport = '下一次运行的新回流'
  pending.push(newReport)
  const result = await bounded(runAgent({ ...opts, extraSystemMessages: [] }).done)
  assert.equal(result.reason, 'complete')
  assert.equal(provider.mainMessages.length, 2)
  const next = provider.mainMessages[1]
  assert.equal(occurrences(next, returnedReport), 0)
  assert.equal(occurrences(next, onceHint), 0)
  assert.equal(occurrences(next, newReport), 1)
})

await check('重试达到上限时始终携带原注入，并停止请求', async () => {
  const { provider, pending, opts, roundStarts } = injectionFixture(false)
  provider.alwaysOverflow = true
  provider.onSummary = async () => { provider.summaryText = provider.summaryRequests === 1 ? 's'.repeat(1800) : '简短摘要' }
  const result = await bounded(runAgent(opts).done)
  assert.equal(result.reason, 'error')
  assert.equal(result.errorMessage, provider.errorMessage)
  assert.equal(provider.summaryRequests, 2)
  assert.equal(provider.mainMessages.length, 3)
  for (const messages of provider.mainMessages) {
    assert.equal(occurrences(messages, returnedReport), 1)
    assert.equal(occurrences(messages, onceHint), 1)
  }
  assert.deepEqual(roundStarts, [1])
  assert.equal(pending.length, 0)
})

await check('支持常见超限码和描述，配额、网络与输出参数错误不触发摘要', async () => {
  for (const error of ['context_length_exceeded', 'context_window_exceeded', 'prompt is too long: 9000 tokens > 8192 maximum', 'input length exceeds the context window', 'token limit exceeded']) {
    const history = historyFixture()
    const provider = new OverflowProvider()
    provider.errorMessage = error
    const result = await bounded(startAgent(provider, history, runtimeContext(provider, history)).done)
    assert.equal(result.reason, 'complete', error)
    assert.equal(provider.summaryRequests, 1, error)
  }
  for (const error of ['maximum retries exceeded', '请求耗时太长: request took too long', 'context connection failed', 'quota exceeded', 'max_tokens is too large']) {
    const history = historyFixture()
    const provider = new OverflowProvider()
    provider.errorMessage = error
    const result = await bounded(startAgent(provider, history, runtimeContext(provider, history)).done)
    assert.equal(result.reason, 'error', error)
    assert.equal(result.errorMessage, error)
    assert.equal(provider.summaryRequests, 0, error)
    assert.equal(provider.mainInputs.length, 1, error)
  }
})

console.log(`\ncontext_overflow_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
