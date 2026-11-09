import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runAgent } from '../src/agent/loop.ts'
import type { AgentHandle } from '../src/agent/events.ts'
import { ContextManager } from '../src/context/index.ts'
import { HookEngine } from '../src/hook/engine.ts'
import { RuleEngine } from '../src/permission/index.ts'
import type { Provider, StreamChatOptions, StreamEvent } from '../src/provider/types.ts'
import { createAgentRuntimeContext } from '../src/runtime/agent-context.ts'
import { History } from '../src/session/history.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { createSessionActions } from '../src/tui/session-actions.ts'

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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('取消后仍在等待')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function largeHistory(): History {
  const history = new History()
  for (let index = 0; index < 40; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}:` + 'x'.repeat(500) })
  return history
}

class DeferredProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly waiting = deferred()
  readonly finished = deferred()
  readonly gate = deferred()
  summaryRequests = 0
  mainRequests = 0
  summarySignal: AbortSignal | undefined
  blocked = true
  ignoreAbort = false
  overflow = false

  async *streamChat(_: unknown, opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    if (opts.tools !== undefined) {
      this.mainRequests++
      if (this.overflow) {
        yield { type: 'usage', inputTokens: 19500, outputTokens: 1 }
        yield { type: 'error', message: 'maximum context length exceeded' }
      } else {
        yield { type: 'text', text: '正常回答' }
      }
      return
    }
    this.summaryRequests++
    this.summarySignal = opts.signal
    if (!this.blocked) {
      yield { type: 'text', text: '完整摘要' }
      return
    }
    const onAbort = (): void => this.gate.resolve()
    try {
      yield { type: 'text', text: '部分摘要' }
      if (!this.ignoreAbort) opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.resolve()
      await this.gate.promise
      yield { type: 'text', text: '迟到摘要' }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      this.finished.resolve()
    }
  }
}

function managerFixture(provider: Provider, hooks?: HookEngine) {
  const history = largeHistory()
  const manager = new ContextManager({ provider, history, hooks, cwd: process.cwd(), window: 6000, autoMargin: 2000, manualMargin: 2000 })
  return { history, manager }
}

function runtimeFixture(provider: Provider, window = 6000, inputTokens?: number) {
  const history = largeHistory()
  const engine = new RuleEngine(...(['user', 'project', 'local'].map((name) => join(tmpdir(), `meicode-cancel-${name}.yaml`)) as [string, string, string]))
  const ctx = createAgentRuntimeContext({ provider, history, engine, cwd: process.cwd(), contextWindow: window })
  if (inputTokens !== undefined) ctx.afterRequest?.(inputTokens, history.length)
  const agent = runAgent({ provider, history, ctx, registry: new ToolRegistry(), maxIterations: 1, mode: 'full', systemPrompt: '取消回归', unknownToolLimit: 2 })
  return { history, agent }
}

async function assertCancelled(agent: AgentHandle): Promise<void> {
  const result = await bounded(agent.done)
  assert.equal(result.reason, 'cancelled')
  assert.equal(result.errorMessage, undefined)
  const events = []
  for await (const event of agent.events) events.push(event)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert(events.some((event) => event.type === 'done' && event.reason === 'cancelled'))
  assert(!events.some((event) => event.type === 'text'))
}

for (const ignoreAbort of [false, true]) {
  await check(`自动摘要取消保留 40 条历史且不发主请求，供应商${ignoreAbort ? '忽略' : '响应'}取消`, async () => {
    const provider = new DeferredProvider()
    provider.ignoreAbort = ignoreAbort
    const { history, agent } = runtimeFixture(provider, 6000, 5800)
    const original = JSON.stringify(history.view())
    const version = history.version
    try {
      await bounded(provider.waiting.promise)
      agent.cancel()
      await assertCancelled(agent)
      assert(provider.summarySignal?.aborted)
      assert.equal(JSON.stringify(history.view()), original)
      assert.equal(history.version, version)
      assert.equal(provider.mainRequests, 0)
      assert.equal(provider.summaryRequests, 1)
    } finally {
      agent.cancel()
      provider.gate.resolve()
      await bounded(provider.finished.promise)
      await bounded(agent.done)
    }
    assert.equal(JSON.stringify(history.view()), original)
    assert.equal(provider.mainRequests, 0)
  })
}

await check('上下文超限重试的手动摘要可取消，最后一轮仍报告 cancelled', async () => {
  const provider = new DeferredProvider()
  provider.overflow = true
  const { history, agent } = runtimeFixture(provider, 20000)
  const original = JSON.stringify(history.view())
  try {
    await bounded(provider.waiting.promise)
    agent.cancel()
    await assertCancelled(agent)
    assert(provider.summarySignal?.aborted)
    assert.equal(provider.mainRequests, 1)
    assert.equal(provider.summaryRequests, 1)
    assert.equal(JSON.stringify(history.view()), original)
  } finally {
    agent.cancel()
    provider.gate.resolve()
    await bounded(agent.done)
  }
})

await check('预先取消不启动压缩，也不打断已有手动摘要', async () => {
  const provider = new DeferredProvider()
  const { manager, history } = managerFixture(provider)
  const parent = new AbortController()
  parent.abort()
  await manager.beforeRequest('auto', parent.signal)
  assert.equal(provider.summaryRequests, 0)
  const manual = manager.compact()
  try {
    await bounded(provider.waiting.promise)
    await bounded(manager.beforeRequest('auto', parent.signal))
    assert(!provider.summarySignal?.aborted)
    provider.gate.resolve()
    assert.equal((await bounded(manual)).status, 'compacted')
    assert.equal(history.length, 7)
    assert.equal(provider.summaryRequests, 1)
  } finally {
    provider.gate.resolve()
    await bounded(manual)
  }
})

await check('取消并发等待者及时退出，原手动摘要继续完成', async () => {
  const provider = new DeferredProvider()
  const { manager, history } = managerFixture(provider)
  const parent = new AbortController()
  const manual = manager.compact()
  try {
    await bounded(provider.waiting.promise)
    const waiter = manager.beforeRequest('auto', parent.signal)
    parent.abort()
    await bounded(waiter)
    assert(!provider.summarySignal?.aborted)
    assert.equal(history.length, 40)
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    provider.gate.resolve()
    assert.equal((await bounded(manual)).status, 'compacted')
    assert.equal(history.length, 7)
    assert.equal(provider.summaryRequests, 1)
  } finally {
    parent.abort()
    provider.gate.resolve()
    await bounded(manual)
  }
})

await check('取消摘要发起者唤醒所有等待者，手动压缩显示取消且可重试', async () => {
  const provider = new DeferredProvider()
  provider.ignoreAbort = true
  const { manager, history } = managerFixture(provider)
  const original = JSON.stringify(history.view())
  const parent = new AbortController()
  const actions = createSessionActions({ history, contextManager: manager, isStreaming: () => false, resetUi: () => {} })
  const automatic = manager.beforeRequest('auto', parent.signal)
  try {
    await bounded(provider.waiting.promise)
    const manual = actions.compact()
    parent.abort()
    await bounded(automatic)
    assert.equal(await bounded(manual), '压缩已取消，请重试')
    assert(provider.summarySignal?.aborted)
    assert.equal(JSON.stringify(history.view()), original)
    provider.blocked = false
    assert.equal(await bounded(actions.compact()), '压缩完成：早期对话已摘要')
    assert.equal(provider.summaryRequests, 2)
    const expected = JSON.stringify(history.view())
    provider.gate.resolve()
    await bounded(provider.finished.promise)
    assert.equal(JSON.stringify(history.view()), expected)
    assert.equal(manager.lastSummary, '完整摘要')
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  } finally {
    parent.abort()
    provider.gate.resolve()
    await bounded(automatic)
  }
})

await check('pre_compact 等待可取消，迟到 Hook 不发摘要也不覆盖重试结果', async () => {
  const provider = new DeferredProvider()
  provider.blocked = false
  const waiting = deferred()
  const gate = deferred()
  const finished = deferred()
  const hooks = new HookEngine([])
  let first = true
  hooks.fire = async (event) => {
    if (event === 'pre_compact' && first) {
      first = false
      waiting.resolve()
      await gate.promise
      finished.resolve()
    }
  }
  const { manager, history } = managerFixture(provider, hooks)
  const original = JSON.stringify(history.view())
  const parent = new AbortController()
  const request = manager.beforeRequest('auto', parent.signal)
  try {
    await bounded(waiting.promise)
    parent.abort()
    await bounded(request)
    assert.equal(JSON.stringify(history.view()), original)
    assert.equal(provider.summaryRequests, 0)
    assert.equal((await bounded(manager.compact())).status, 'compacted')
    const expected = JSON.stringify(history.view())
    gate.resolve()
    await bounded(finished.promise)
    assert.equal(provider.summaryRequests, 1)
    assert.equal(JSON.stringify(history.view()), expected)
    assert(!manager.breakerOpenState)
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  } finally {
    parent.abort()
    gate.resolve()
    await bounded(request)
  }
})

await check('连续取消不计入失败熔断，之后自动压缩仍成功', async () => {
  let parent: AbortController
  let cancel = true
  let requests = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(): AsyncGenerator<StreamEvent> {
      requests++
      if (cancel) parent.abort()
      yield { type: 'text', text: cancel ? '部分摘要' : '完整摘要' }
    },
  }
  const { manager, history } = managerFixture(provider)
  for (let index = 0; index < 3; index++) {
    parent = new AbortController()
    await bounded(manager.beforeRequest('auto', parent.signal))
    assert.equal(history.length, 40)
    assert(!manager.breakerOpenState)
  }
  assert.equal(requests, 3)
  cancel = false
  await manager.beforeRequest('auto')
  assert.equal(requests, 4)
  assert.equal(history.length, 7)
  assert(!manager.breakerOpenState)
})

await check('请求前回调抛出取消异常时 Agent 正常结束', async () => {
  const waiting = deferred()
  const provider = new DeferredProvider()
  const agent = runAgent({
    provider, history: largeHistory(), registry: new ToolRegistry(), maxIterations: 1, mode: 'full', systemPrompt: '取消回归', unknownToolLimit: 2,
    ctx: {
      cwd: process.cwd(),
      beforeRequest: (_, signal) => new Promise<void>((_, reject) => {
        assert(signal)
        signal.addEventListener('abort', () => reject(new Error('回调已取消')), { once: true })
        waiting.resolve()
      }),
    },
  })
  try {
    await bounded(waiting.promise)
    agent.cancel()
    await assertCancelled(agent)
    assert.equal(provider.mainRequests, 0)
    assert.equal(provider.summaryRequests, 0)
  } finally {
    agent.cancel()
    await bounded(agent.done)
  }
})

console.log(`\ncontext_cancellation_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
