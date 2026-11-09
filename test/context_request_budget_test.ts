import assert from 'node:assert/strict'
import { runAgent } from '../src/agent/loop.ts'
import { estimateMessageTokens, TokenEstimator } from '../src/context/estimate.ts'
import { ContextManager } from '../src/context/manager.ts'
import { SUMMARY_SYSTEM } from '../src/context/summary.ts'
import { HookEngine } from '../src/hook/engine.ts'
import type { HookRule } from '../src/hook/types.ts'
import { RuleEngine } from '../src/permission/rules.ts'
import type { ChatMessage, Provider, StreamChatOptions, StreamEvent } from '../src/provider/types.ts'
import { createAgentRuntimeContext } from '../src/runtime/agent-context.ts'
import { History } from '../src/session/history.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolContext } from '../src/tools/types.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('预算回归未及时结束')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function tokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

class BudgetProvider implements Provider {
  readonly protocol = 'openai' as const
  ctx!: ToolContext
  usage = true
  calibration = 400
  summaryBeforeMain: number[] = []
  summaryBudgets: number[] = []
  requests: Array<{ messages: ChatMessage[]; estimate: number; input: number }> = []
  onMain: (index: number) => StreamEvent[] = (index) => index === 0
    ? [{ type: 'tool_call', id: 'probe-1', name: 'probe', arguments: {} }]
    : [{ type: 'text', text: '完成' }]
  beforeUsage: ((index: number) => void) | undefined
  onSummary: ((options: StreamChatOptions) => void | Promise<void>) | undefined

  async *streamChat(messages: ChatMessage[], opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    if (messages[0]?.content === SUMMARY_SYSTEM) {
      this.summaryBeforeMain.push(this.requests.length)
      this.summaryBudgets.push(this.ctx.contextBudget!().estimatedTokens)
      await this.onSummary?.(opts)
      yield { type: 'text', text: '早期对话简短摘要' }
    } else {
      const index = this.requests.length
      const toolTokens = opts.tools?.length ? Math.ceil(JSON.stringify(opts.tools).length / 4) : 0
      const input = tokens(messages) + toolTokens + this.calibration
      this.requests.push({ messages: [...messages], estimate: this.ctx.contextBudget!().estimatedTokens, input })
      this.beforeUsage?.(index)
      if (this.usage) yield { type: 'usage', inputTokens: input, outputTokens: 1 }
      yield* this.onMain(index)
    }
    yield { type: 'done' }
  }
}

function fixture(options: { contentLength?: number; hooks?: HookEngine } = {}) {
  const history = new History()
  const length = options.contentLength ?? 200
  for (let index = 0; index < 20; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}:` + 'x'.repeat(length - `${index}:`.length) })
  const provider = new BudgetProvider()
  const ctx = createAgentRuntimeContext({
    provider, history, cwd: process.cwd(), contextWindow: 8192, hooks: options.hooks,
    engine: new RuleEngine('unused-user', 'unused-project', 'unused-local'), sessionId: 'request-budget', agentId: 'budget-agent',
  })
  provider.ctx = ctx
  const registry = new ToolRegistry()
  registry.register({ name: 'probe', description: '本地预算探针', parameters: { type: 'object' }, async execute() { return { success: true, output: '正常结果'.repeat(20) } } })
  const pending: string[] = []
  const opts = {
    provider, history, ctx, registry, maxIterations: 2, mode: 'full' as const, unknownToolLimit: 2,
    systemPrompt: '本地请求预算', injectSystem: () => pending.splice(0, pending.length),
  }
  return { history, provider, ctx, registry, pending, opts }
}

await check('估算包含当前请求开销，API 校准只加历史增量和开销差额', () => {
  const history: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(400) }]
  const estimator = new TokenEstimator()
  assert.equal(estimator.estimate(history, 6000), 6100)
  estimator.update(6500, history.length, 6000)
  assert.equal(estimator.estimate(history, 6000), 6500)
  history.push({ role: 'assistant', content: 'y'.repeat(80) })
  assert.equal(estimator.estimate(history, 0), 520)
  assert.equal(estimator.estimate(history, 2000), 2520)
  estimator.update(200, history.length, 1000)
  assert.equal(estimator.estimate(history, 0), 0)
})

await check('仅开销变化也使预算缓存失效，结构变化保留当前开销，reset 清空', () => {
  const history = new History()
  history.push({ role: 'user', content: 'x'.repeat(400) })
  const manager = new ContextManager({ provider: new BudgetProvider(), history, cwd: process.cwd(), window: 8192 })
  const version = history.version
  manager.setRequestOverhead(6000)
  assert.equal(manager.snapshot().estimatedTokens, 6100)
  manager.afterRequest(6500, history.length, 6000)
  manager.setRequestOverhead(0)
  assert.equal(manager.snapshot().estimatedTokens, 500)
  manager.setRequestOverhead(2000)
  assert.equal(manager.snapshot().estimatedTokens, 2500)
  assert.equal(history.version, version)
  history.replaceRange(0, 1, [{ role: 'user', content: 'x'.repeat(80) }])
  assert.equal(manager.snapshot().estimatedTokens, 2020)
  manager.reset()
  assert.equal(manager.snapshot().estimatedTokens, 20)
  assert.equal(manager.snapshot().lastInputTokens, undefined)
})

await check('一次性回流被消费后，下一轮不误摘要且保留 API 校准和原历史', async () => {
  const { history, provider, pending, opts } = fixture()
  const original = history.all()
  const report = '[子任务结果]' + 'R'.repeat(24000)
  pending.push(report)
  const result = await bounded(runAgent(opts).done)
  assert.equal(result.reason, 'complete')
  assert.equal(provider.requests.length, 2)
  assert(provider.requests[0].input > 7373 && provider.requests[0].input < 8192)
  assert.deepEqual(provider.summaryBeforeMain, [])
  assert.deepEqual(history.view().slice(0, original.length), original)
  assert(provider.requests[0].messages.some((message) => message.content === report))
  assert(!provider.requests[1].messages.some((message) => message.content === report))
  assert.equal(provider.requests[1].estimate, provider.requests[1].input)
  assert(provider.requests[1].estimate < 2000)
})

await check('下一轮新增大回流计入预算，在发送前摘要而非漏算新消息', async () => {
  const { provider, pending, opts } = fixture()
  const report = '[新子任务结果]' + 'R'.repeat(24000)
  provider.beforeUsage = (index) => { if (index === 0) pending.push(report) }
  const result = await bounded(runAgent(opts).done)
  assert.equal(result.reason, 'complete')
  assert.deepEqual(provider.summaryBeforeMain, [1])
  assert(provider.summaryBudgets[0] > 7373)
  assert.equal(provider.requests[0].messages.filter((message) => message.content === report).length, 0)
  assert.equal(provider.requests[1].messages.filter((message) => message.content === report).length, 1)
  const callIndex = provider.requests[1].messages.findIndex((message) => message.tool_calls?.[0]?.id === 'probe-1')
  assert(callIndex >= 0)
  assert.equal(provider.requests[1].messages[callIndex + 1].tool_call_id, 'probe-1')
})

await check('供应商未返回 usage 时，当前注入仍计入冷启动预算，移除后重算', async () => {
  const { provider, pending, opts } = fixture()
  provider.usage = false
  const report = '[无用量回流]' + 'R'.repeat(20000)
  pending.push(report)
  assert.equal((await bounded(runAgent(opts).done)).reason, 'complete')
  for (const request of provider.requests) assert.equal(request.estimate, request.input - provider.calibration)
  assert.deepEqual(provider.summaryBeforeMain, [])
  assert(provider.requests[0].estimate > provider.requests[1].estimate + 4000)
})

await check('跨运行改变系统提示及工具定义时按差额估算，不重复计算旧 schema', async () => {
  const { provider, opts } = fixture()
  provider.onMain = () => [{ type: 'text', text: '完成' }]
  assert.equal((await bounded(runAgent({ ...opts, maxIterations: 1 }).done)).reason, 'complete')
  const nextRegistry = new ToolRegistry()
  nextRegistry.register({ name: 'probe', description: 'D'.repeat(4000), parameters: { type: 'object' }, async execute() { return { success: true, output: '完成' } } })
  assert.equal((await bounded(runAgent({ ...opts, registry: nextRegistry, systemPrompt: 'S'.repeat(1000), maxIterations: 1 }).done)).reason, 'complete')
  assert.equal(provider.requests.length, 2)
  assert.equal(provider.requests[1].estimate, provider.requests[1].input)
  assert(provider.requests[1].estimate > provider.requests[0].input + 1000)
})

await check('长固定前缀在首次请求前计入预算并主动压缩', async () => {
  const { provider, opts } = fixture({ contentLength: 600 })
  provider.calibration = 0
  provider.onMain = () => [{ type: 'text', text: '完成' }]
  assert.equal((await bounded(runAgent({ ...opts, maxIterations: 1, extraSystemMessages: ['S'.repeat(22000)] }).done)).reason, 'complete')
  assert.deepEqual(provider.summaryBeforeMain, [0])
  assert.equal(provider.requests.length, 1)
  assert.equal(provider.requests[0].estimate, provider.requests[0].input)
  assert(provider.requests[0].input < 8192)
})

await check('压缩前后 Hook 和摘要期间新回流进入本次请求，预算与最终组装一致', async () => {
  const hooks = new HookEngine([
    { event: 'pre_compact', action: { type: 'inject_prompt', content: 'PRE'.repeat(80) } },
    { event: 'post_compact', action: { type: 'inject_prompt', content: 'POST'.repeat(80) } },
  ])
  const { provider, pending, opts } = fixture({ contentLength: 600, hooks })
  provider.calibration = 0
  provider.onMain = () => [{ type: 'text', text: '完成' }]
  const report = '压缩期间的新回流'
  provider.onSummary = () => { pending.push(report) }
  assert.equal((await bounded(runAgent({ ...opts, maxIterations: 1, extraSystemMessages: ['S'.repeat(22000)] }).done)).reason, 'complete')
  const request = provider.requests[0]
  for (const content of ['PRE'.repeat(80), 'POST'.repeat(80), report]) assert.equal(request.messages.filter((message) => message.content === content).length, 1)
  assert.equal(request.estimate, request.input)
})

await check('请求发出后追加的历史不算进旧 usage 的消息数，下一轮完整计入增量', async () => {
  const { history, provider, opts } = fixture()
  const added = { role: 'user' as const, content: '并发追加'.repeat(250) }
  provider.beforeUsage = (index) => { if (index === 0) history.push(added) }
  assert.equal((await bounded(runAgent(opts).done)).reason, 'complete')
  assert(!provider.requests[0].messages.some((message) => message.content === added.content))
  assert(provider.requests[1].messages.some((message) => message.content === added.content))
  assert.equal(provider.requests[1].estimate, provider.requests[1].input)
})

await check('启用请求开销跟踪后，强制重试仍保留原注入并计入新回流', async () => {
  const onceHint = '一次性重试提示'
  const hooks = new HookEngine([{ event: 'round_start', once: true, action: { type: 'inject_prompt', content: onceHint } }])
  const { provider, pending, opts } = fixture({ hooks })
  provider.calibration = 0
  const report = '[原回流]' + 'R'.repeat(1000)
  const newReport = '[压缩期间的新回流]'
  pending.push(report)
  provider.onSummary = () => { pending.push(newReport) }
  provider.onMain = (index) => index === 0
    ? [{ type: 'error', message: 'maximum context length exceeded' }]
    : [{ type: 'text', text: '恢复完成' }]
  const result = await bounded(runAgent({ ...opts, maxIterations: 1 }).done)
  assert.equal(result.reason, 'complete')
  assert.equal(result.rounds, 1)
  assert.deepEqual(provider.summaryBeforeMain, [1])
  assert.equal(provider.requests.length, 2)
  for (const request of provider.requests) {
    assert.equal(request.estimate, request.input)
    assert.equal(request.messages.filter((message) => message.content === report).length, 1)
    assert.equal(request.messages.filter((message) => message.content === onceHint).length, 1)
  }
  assert.equal(provider.requests[1].messages.filter((message) => message.content === newReport).length, 1)
})

await check('首次主请求前取消摘要，旧回流按顺序退回并在同会话继续时只投递一次', async () => {
  const { history, provider, pending, opts } = fixture({ contentLength: 600 })
  const original = history.all()
  const first = '[子任务结果] ORDER-42'
  const second = '[摘要期间新结果] ORDER-43'
  pending.push(first)
  let summaryStarted!: () => void
  const started = new Promise<void>((resolve) => { summaryStarted = resolve })
  provider.onSummary = async (options) => {
    summaryStarted()
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  const agent = runAgent({
    ...opts,
    maxIterations: 1,
    extraSystemMessages: ['S'.repeat(22000)],
    restoreUnsentSystem: (messages) => pending.unshift(...messages),
  })
  try {
    await bounded(started)
    assert.equal(pending.length, 0)
    pending.push(second)
    agent.cancel()
    assert.equal((await bounded(agent.done)).reason, 'cancelled')
  } finally {
    agent.cancel()
    await bounded(agent.done)
  }
  assert.equal(provider.requests.length, 0)
  assert.deepEqual(history.all(), original)
  assert.deepEqual(pending, [first, second])

  provider.onSummary = undefined
  provider.onMain = () => [{ type: 'text', text: '已收到结果' }]
  const continued = { ...opts, maxIterations: 1, extraSystemMessages: [] }
  assert.equal((await bounded(runAgent(continued).done)).reason, 'complete')
  assert.deepEqual(provider.requests[0].messages.slice(-2).map((message) => message.content), [first, second])
  assert.deepEqual(pending, [])
  assert.equal((await bounded(runAgent(continued).done)).reason, 'complete')
  assert.equal(provider.requests[1].messages.filter((message) => message.content === first || message.content === second).length, 0)
})

await check('主请求已尝试发送后取消，不退回已投递回流', async () => {
  const { provider, pending, opts } = fixture()
  const report = '[已发送回流] ORDER-42'
  pending.push(report)
  let agent!: ReturnType<typeof runAgent>
  provider.beforeUsage = () => agent.cancel()
  agent = runAgent({ ...opts, maxIterations: 1, restoreUnsentSystem: (messages) => pending.unshift(...messages) })
  assert.equal((await bounded(agent.done)).reason, 'cancelled')
  assert.equal(provider.requests.length, 1)
  assert.equal(provider.requests[0].messages.filter((message) => message.content === report).length, 1)
  assert.deepEqual(pending, [])
})

await check('后续轮摘要取消，只退回该轮尚未发送的新回流', async () => {
  const { provider, pending, opts } = fixture()
  const first = '[首轮已投递] ORDER-42'
  const second = '[次轮未投递] ORDER-43' + 'R'.repeat(24000)
  pending.push(first)
  provider.beforeUsage = (index) => { if (index === 0) pending.push(second) }
  let summaryStarted!: () => void
  const started = new Promise<void>((resolve) => { summaryStarted = resolve })
  provider.onSummary = async (options) => {
    summaryStarted()
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  const agent = runAgent({ ...opts, restoreUnsentSystem: (messages) => pending.unshift(...messages) })
  try {
    await bounded(started)
    agent.cancel()
    assert.equal((await bounded(agent.done)).reason, 'cancelled')
  } finally {
    agent.cancel()
    await bounded(agent.done)
  }
  assert.equal(provider.requests.length, 1)
  assert.deepEqual(pending, [second])
})

await check('首次主请求前取消摘要，一次性 Hook 和压缩前提示在同会话继续时只投递一次', async () => {
  const roundHint = '一次性 round_start 提示 ORDER-42'
  const compactHint = '一次性 pre_compact 提示 ORDER-43'
  const roundRule: HookRule = { event: 'round_start', once: true, action: { type: 'inject_prompt', content: roundHint } }
  const compactRule: HookRule = { event: 'pre_compact', once: true, action: { type: 'inject_prompt', content: compactHint } }
  const hooks = new HookEngine([roundRule, compactRule])
  const { provider, opts } = fixture({ contentLength: 600, hooks })
  let summaryStarted!: () => void
  const started = new Promise<void>((resolve) => { summaryStarted = resolve })
  provider.onSummary = async (options) => {
    summaryStarted()
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  const agent = runAgent({ ...opts, maxIterations: 1, extraSystemMessages: ['S'.repeat(22000)] })
  try {
    await bounded(started)
    agent.cancel()
    assert.equal((await bounded(agent.done)).reason, 'cancelled')
  } finally {
    agent.cancel()
    await bounded(agent.done)
  }
  assert.equal(provider.requests.length, 0)
  assert.equal(roundRule.fired, true)
  assert.equal(compactRule.fired, true)

  provider.onSummary = undefined
  provider.onMain = () => [{ type: 'text', text: '收到提示' }]
  const continued = { ...opts, maxIterations: 1, extraSystemMessages: [] }
  assert.equal((await bounded(runAgent(continued).done)).reason, 'complete')
  const first = provider.requests[0].messages.map((message) => message.content)
  assert.equal(first.filter((content) => content === roundHint).length, 1)
  assert.equal(first.filter((content) => content === compactHint).length, 1)
  assert(first.indexOf(roundHint) < first.indexOf(compactHint))
  assert.equal((await bounded(runAgent(continued).done)).reason, 'complete')
  const second = provider.requests[1].messages.map((message) => message.content)
  assert.equal(second.filter((content) => content === roundHint || content === compactHint).length, 0)
})

await check('后续轮摘要取消，只退回尚未发送的 Hook 提示', async () => {
  const firstHint = '首轮已投递 Hook'
  const secondHint = '次轮未投递 Hook' + 'R'.repeat(24000)
  const hooks = new HookEngine([
    { event: 'round_start', once: true, action: { type: 'inject_prompt', content: firstHint } },
    { event: 'tool_after', once: true, action: { type: 'inject_prompt', content: secondHint } },
  ])
  const { provider, opts } = fixture({ hooks })
  let summaryStarted!: () => void
  const started = new Promise<void>((resolve) => { summaryStarted = resolve })
  provider.onSummary = async (options) => {
    summaryStarted()
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  const agent = runAgent(opts)
  try {
    await bounded(started)
    agent.cancel()
    assert.equal((await bounded(agent.done)).reason, 'cancelled')
  } finally {
    agent.cancel()
    await bounded(agent.done)
  }
  assert.equal(provider.requests.length, 1)
  assert.equal(provider.requests[0].messages.filter((message) => message.content === firstHint).length, 1)
  assert.equal(provider.requests[0].messages.filter((message) => message.content === secondHint).length, 0)

  provider.onSummary = undefined
  assert.equal((await bounded(runAgent({ ...opts, maxIterations: 1 }).done)).reason, 'complete')
  const next = provider.requests[1].messages
  assert.equal(next.filter((message) => message.content === firstHint).length, 0)
  assert.equal(next.filter((message) => message.content === secondHint).length, 1)
})

console.log(`\ncontext_request_budget_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
