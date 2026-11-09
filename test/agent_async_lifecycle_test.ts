import assert from 'node:assert/strict'
import { runAgent } from '../src/agent/loop.ts'
import type { AgentEvent, AgentHandle } from '../src/agent/events.ts'
import { executeToolBatch, executeToolCall } from '../src/agent/tool-execution.ts'
import { HookEngine } from '../src/hook/engine.ts'
import type { HookEventName } from '../src/hook/types.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import type { RuntimeEventInput } from '../src/runtime/events.ts'
import { History } from '../src/session/history.ts'
import { createLeadTools } from '../src/team/lead-tools.ts'
import type { TeamManager } from '../src/team/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { Tool, ToolContext } from '../src/tools/types.ts'

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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('异步任务未及时结束')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function tool(name: string, execute: Tool['execute']): Tool {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute }
}

function call(name: string, id = name): Extract<StreamEvent, { type: 'tool_call' }> {
  return { type: 'tool_call', id, name, arguments: {} }
}

function provider(events: StreamEvent[]): Provider {
  return { protocol: 'openai', async *streamChat() { yield* events } }
}

function fixture(source: Provider, registry = new ToolRegistry(), extraCtx: Partial<ToolContext> = {}) {
  const history = new History()
  history.push({ role: 'user', content: '旧会话任务' })
  const runtimeRecords: RuntimeEventInput[] = []
  const record = (input: RuntimeEventInput) => { runtimeRecords.push(input) }
  const hookRecords: Array<{ event: HookEventName; sessionId?: string }> = []
  const hooks = new HookEngine([])
  const fire = hooks.fire.bind(hooks)
  hooks.fire = async (event, scope) => {
    hookRecords.push({ event, sessionId: scope.sessionId })
    await fire(event, scope)
  }
  const ctx: ToolContext = {
    cwd: process.cwd(), sessionId: 'old-session', agentId: 'shared-agent', hooks,
    runtimeEvents: { append: record, appendBatch: (inputs: readonly RuntimeEventInput[]) => inputs.forEach(record) } as unknown as ToolContext['runtimeEvents'],
    ...extraCtx,
  }
  const opts = { provider: source, history, registry, ctx, maxIterations: 1, mode: 'full' as const, unknownToolLimit: 2, systemPrompt: '异步边界测试' }
  const switchSession = () => {
    history.clear()
    ctx.sessionId = 'new-session'
    history.push({ role: 'user', content: '新会话专属内容' })
  }
  return { opts, history, ctx, hooks, runtimeRecords, hookRecords, switchSession }
}

async function finish(agent: AgentHandle) {
  const result = await bounded(agent.done)
  const events: AgentEvent[] = []
  for await (const event of agent.events) events.push(event)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  return { result, events }
}

function assertNewSession(f: ReturnType<typeof fixture>) {
  assert.deepEqual(f.history.view(), [{ role: 'user', content: '新会话专属内容' }])
  assert(f.runtimeRecords.every((event) => event.sessionId === 'old-session'))
  assert(f.hookRecords.every((record) => record.sessionId === 'old-session'))
  assert(!f.hookRecords.some((record) => record.event === 'round_end'))
}

await check('预先取消的工具不触发权限、Hook 或执行', async () => {
  const controller = new AbortController()
  controller.abort()
  const registry = new ToolRegistry()
  let effects = 0
  registry.register(tool('effect', async () => { effects++; return { success: true, output: '执行' } }))
  const hooks = new HookEngine([])
  hooks.fire = async () => { effects++ }
  hooks.intercept = async () => { effects++; return null }
  const result = await executeToolCall(call('effect'), registry, {
    cwd: process.cwd(), signal: controller.signal, hooks,
    permission: { mode: 'permissive', engine: { match: () => { effects++; return null }, addSessionRule: () => {}, appendProjectRule: () => {} } },
  })
  assert.equal(result.success, false)
  assert(result.error?.includes('取消'))
  assert.equal(effects, 0)
})

await check('等待 tool_before Hook 时取消，Hook 返回后不执行工具', async () => {
  const started = deferred()
  const gate = deferred()
  const controller = new AbortController()
  const registry = new ToolRegistry()
  let executions = 0
  registry.register(tool('effect', async () => { executions++; return { success: true, output: '执行' } }))
  const hooks = new HookEngine([])
  hooks.intercept = async () => { started.resolve(); await gate.promise; return null }
  const pending = executeToolCall(call('effect'), registry, { cwd: process.cwd(), hooks, signal: controller.signal })
  try {
    await bounded(started.promise)
    controller.abort()
    gate.resolve()
    const result = await bounded(pending)
    assert.equal(executions, 0)
    assert(result.error?.includes('取消'))
  } finally {
    controller.abort()
    gate.resolve()
    await bounded(pending)
  }
})

await check('取消期间迟到的权限批准不写入授权规则或执行工具', async () => {
  for (const answer of ['session', 'forever'] as const) {
    const controller = new AbortController()
    const registry = new ToolRegistry()
    let effects = 0
    registry.register(tool('effect', async () => { effects++; return { success: true, output: '执行' } }))
    const result = await executeToolCall(call('effect'), registry, {
      cwd: process.cwd(), signal: controller.signal,
      permission: { mode: 'default', engine: { match: () => null, addSessionRule: () => { effects++ }, appendProjectRule: () => { effects++ } } },
      ask: async () => { controller.abort(); return answer },
    })
    assert(result.error?.includes('取消'))
    assert.equal(effects, 0)
  }
})

await check('最后一轮工具取消后不执行 team_create，保持消息配对且报告 cancelled', async () => {
  const started = deferred()
  const gate = deferred()
  const registry = new ToolRegistry()
  registry.register(tool('hold', async (_, ctx) => {
    started.resolve()
    await resolveOnAbort(gate.promise, ctx.signal, undefined)
    return { success: false, output: '', error: '工具执行已取消' }
  }))
  let groupsCreated = 0
  const team = { loadGroup: () => null, createGroup: () => { groupsCreated++ } } as unknown as TeamManager
  registry.register(createLeadTools(team).find((item) => item.name === 'team_create')!)
  const create = { ...call('team_create'), arguments: { name: 'cancelled-group' } }
  const f = fixture(provider([call('hold'), create, { type: 'done' }]), registry, {
    permission: { mode: 'permissive', engine: { match: () => null, addSessionRule: () => {}, appendProjectRule: () => {} } },
  })
  const agent = runAgent(f.opts)
  try {
    await bounded(started.promise)
    agent.cancel()
    const { result, events } = await finish(agent)
    assert.equal(result.reason, 'cancelled')
    assert.equal(result.rounds, 1)
    assert.equal(groupsCreated, 0)
    assert.deepEqual(f.history.view().map((message) => message.role), ['user', 'assistant', 'tool', 'tool'])
    assert.deepEqual(f.history.view().slice(2).map((message) => message.tool_call_id), ['hold', 'team_create'])
    assert(f.history.view()[3].content.includes('取消'))
    assert.equal(events.filter((event) => event.type === 'tool_result').length, 2)
    assert(!f.hookRecords.some((record) => record.event === 'tool_after'))
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('并发读工具取消后，不跨屏障执行后续写工具', async () => {
  const started = deferred()
  const gate = deferred()
  const controller = new AbortController()
  const registry = new ToolRegistry()
  let reads = 0
  let writes = 0
  for (const name of ['read_file', 'find_files']) {
    registry.register(tool(name, async (_, ctx) => {
      if (++reads === 2) started.resolve()
      await resolveOnAbort(gate.promise, ctx.signal, undefined)
      return { success: false, output: '', error: '读取已取消' }
    }))
  }
  registry.register(tool('effect', async () => { writes++; return { success: true, output: '写入' } }))
  const pending = executeToolBatch([call('read_file'), call('find_files'), call('effect')], registry, { cwd: process.cwd(), signal: controller.signal }, () => {})
  try {
    await bounded(started.promise)
    controller.abort()
    const results = await bounded(pending)
    assert.equal(reads, 2)
    assert.equal(writes, 0)
    assert.deepEqual(results.map((item) => item.call.id), ['read_file', 'find_files', 'effect'])
    assert(results[2].result.error?.includes('取消'))
  } finally {
    controller.abort()
    gate.resolve()
    await bounded(pending)
  }
})

await check('模型流切换会话后丢弃迟到用量与回复，不执行已接收工具', async () => {
  const started = deferred()
  const gate = deferred()
  let signal: AbortSignal | undefined
  let executions = 0
  let calibrations = 0
  const registry = new ToolRegistry()
  registry.register(tool('effect', async () => { executions++; return { success: true, output: '执行' } }))
  const source: Provider = {
    protocol: 'openai',
    async *streamChat(_, opts) {
      signal = opts.signal
      yield call('effect')
      started.resolve()
      await gate.promise
      yield { type: 'usage', inputTokens: 1234, outputTokens: 9 }
      yield { type: 'text', text: '迟到的旧回复' }
      yield { type: 'thinking', text: '迟到的旧思考' }
      yield { type: 'done' }
    },
  }
  const f = fixture(source, registry, { afterRequest: () => { calibrations++ } })
  const agent = runAgent(f.opts)
  try {
    await bounded(started.promise)
    f.switchSession()
    gate.resolve()
    const { result, events } = await finish(agent)
    assert.equal(result.reason, 'cancelled')
    assert.equal(result.finalText, '')
    assert.equal(executions, 0)
    assert.equal(calibrations, 0)
    assert(signal?.aborted)
    assert(!events.some((event) => ['text', 'thinking', 'usage', 'tool_result'].includes(event.type)))
    assertNewSession(f)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('模型流切换会话后直接结束，已接收的旧文本不回灌新历史', async () => {
  const started = deferred()
  const gate = deferred()
  const source: Provider = {
    protocol: 'openai',
    async *streamChat() {
      yield { type: 'text', text: '旧会话部分回复' }
      started.resolve()
      await gate.promise
    },
  }
  const f = fixture(source)
  const agent = runAgent(f.opts)
  try {
    await bounded(started.promise)
    f.switchSession()
    gate.resolve()
    const { result } = await finish(agent)
    assert.equal(result.reason, 'cancelled')
    assert.equal(result.finalText, '')
    assertNewSession(f)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('工具执行中切换会话，旧结果和 Hook 不回流且不开始后续工具', async () => {
  const started = deferred()
  const gate = deferred()
  let completedExecutions = 0
  let subsequentExecutions = 0
  const registry = new ToolRegistry()
  registry.register(tool('effect', async () => { completedExecutions++; return { success: true, output: '已完成的旧工具' } }))
  registry.register(tool('hold', async () => { started.resolve(); await gate.promise; return { success: true, output: '迟到的旧工具结果' } }))
  registry.register(tool('next', async () => { subsequentExecutions++; return { success: true, output: '执行' } }))
  const f = fixture(provider([call('effect'), call('hold'), call('next'), { type: 'done' }]), registry)
  const agent = runAgent(f.opts)
  try {
    await bounded(started.promise)
    f.switchSession()
    gate.resolve()
    const { result, events } = await finish(agent)
    assert.equal(result.reason, 'cancelled')
    assert.equal(completedExecutions, 1)
    assert.equal(subsequentExecutions, 0)
    assert.deepEqual(events.filter((event) => event.type === 'tool_result').map((event) => event.id), ['effect'])
    assert.equal(f.hookRecords.filter((record) => record.event === 'tool_after').length, 1)
    assert.deepEqual(f.runtimeRecords.filter((event) => event.type === 'tool_result').map((event) => event.correlationId), ['effect'])
    assertNewSession(f)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('等待工具拦截 Hook 时切换会话，不执行尚未开始的工具', async () => {
  const started = deferred()
  const gate = deferred()
  let executions = 0
  const registry = new ToolRegistry()
  registry.register(tool('effect', async () => { executions++; return { success: true, output: '执行' } }))
  const f = fixture(provider([call('effect'), { type: 'done' }]), registry)
  f.hooks.intercept = async () => { started.resolve(); await gate.promise; return null }
  const agent = runAgent(f.opts)
  try {
    await bounded(started.promise)
    f.switchSession()
    gate.resolve()
    const { result } = await finish(agent)
    assert.equal(result.reason, 'cancelled')
    assert.equal(executions, 0)
    assertNewSession(f)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

await check('工具结果存盘等待期间切换会话，不追加旧 tool 消息', async () => {
  const started = deferred()
  const gate = deferred()
  const registry = new ToolRegistry()
  registry.register(tool('effect', async () => ({ success: true, output: '旧工具结果' })))
  const f = fixture(provider([call('effect'), { type: 'done' }]), registry, {
    spill: async (results) => { started.resolve(); await gate.promise; return results },
  })
  const agent = runAgent(f.opts)
  try {
    await bounded(started.promise)
    f.switchSession()
    gate.resolve()
    const { result } = await finish(agent)
    assert.equal(result.reason, 'cancelled')
    assertNewSession(f)
  } finally {
    agent.cancel()
    gate.resolve()
    await bounded(agent.done)
  }
})

console.log(`\nagent_async_lifecycle_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
