import assert from 'node:assert/strict'
import { estimateMessageTokens } from '../src/context/estimate.ts'
import { ContextManager } from '../src/context/manager.ts'
import { boundaryMessage, summaryMessage, tailKeep } from '../src/context/summary.ts'
import { HookEngine } from '../src/hook/engine.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('摘要请求未及时结束')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function tokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

class SummaryProvider implements Provider {
  readonly protocol = 'openai' as const
  requests = 0
  text = 's'.repeat(16000)
  onRequest: (() => Promise<void>) | undefined

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.requests++
    await this.onRequest?.()
    yield { type: 'text', text: this.text }
    yield { type: 'done' }
  }
}

function fixture(hooks?: HookEngine) {
  const history = new History()
  for (let index = 0; index < 20; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}:` + 'x'.repeat(600 - `${index}:`.length) })
  const provider = new SummaryProvider()
  const manager = new ContextManager({ provider, history, hooks, cwd: process.cwd(), window: 3000, autoMargin: 1000, manualMargin: 1000 })
  const actions = createSessionActions({ history, contextManager: manager, isStreaming: () => false, resetUi() {} })
  return { history, provider, manager, actions }
}

await check('扩张摘要显示失败，保留原文、版本、旧摘要及 API 预算锚点', async () => {
  const hooks = new HookEngine([])
  const events: string[] = []
  hooks.fire = async (event) => { events.push(event) }
  const { history, provider, manager, actions } = fixture(hooks)
  const original = history.all()
  const version = history.version
  const structureVersion = history.structureVersion
  manager.lastSummary = '旧的有效摘要'
  manager.afterRequest(5100, history.length)
  const before = manager.snapshot()
  const message = await actions.compact()
  assert.match(message, /^压缩失败: 摘要未减少上下文/)
  assert.match(message, /已保留原历史/)
  assert.deepEqual(history.view(), original)
  assert.equal(history.version, version)
  assert.equal(history.structureVersion, structureVersion)
  assert.equal(manager.lastSummary, '旧的有效摘要')
  assert.deepEqual(manager.snapshot(), before)
  assert.deepEqual(events, ['pre_compact'])
  assert.equal(provider.requests, 1)
})

await check('包装及边界计入成本，等量摘要也保留原历史', async () => {
  const { history, provider, manager } = fixture()
  const original = history.all()
  const { drop } = tailKeep(original, 300)
  const dropTokens = tokens(drop)
  provider.text = 's'.repeat((dropTokens - estimateMessageTokens(boundaryMessage())) * 4 - summaryMessage('').content.length)
  assert.equal(tokens([summaryMessage(provider.text), boundaryMessage()]), dropTokens)
  assert(provider.text.length < drop.reduce((sum, message) => sum + message.content.length, 0))
  assert.equal((await manager.beforeRequest('auto')).status, 'failed')
  assert.deepEqual(history.view(), original)
  assert.equal(manager.lastSummary, null)
})

await check('摘要正文略短但包装后变长时拒绝，三次失败后停止自动请求', async () => {
  const { history, provider, manager } = fixture()
  const original = history.all()
  const { drop } = tailKeep(original, 300)
  provider.text = 's'.repeat(drop.reduce((sum, message) => sum + message.content.length, 0) - 4)
  assert(tokens([summaryMessage(provider.text), boundaryMessage()]) > tokens(drop))
  for (let index = 0; index < 3; index++) assert.equal((await manager.beforeRequest('auto')).status, 'failed')
  assert(manager.breakerOpenState)
  for (let index = 0; index < 3; index++) assert.deepEqual(await manager.beforeRequest('auto'), { status: 'skipped', reason: 'breaker_open' })
  assert.equal(provider.requests, 3)
  assert.deepEqual(history.view(), original)
  assert.equal(manager.snapshot().estimatedTokens, 3000)
})

await check('工具调用参数和 ID 计入原段成本，正文变长但总量缩减的摘要可以提交', async () => {
  const { history, provider, manager } = fixture()
  history.clear()
  history.push({ role: 'user', content: '处理数据' })
  history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'call-large', name: 'edit_file', arguments: 'a'.repeat(9000) }] })
  history.push({ role: 'tool', content: '完成', tool_call_id: 'call-large' })
  for (let index = 0; index < 5; index++) history.push({ role: 'user', content: 'k'.repeat(600) })
  const recent = history.all().slice(-5)
  const before = manager.snapshot().estimatedTokens
  provider.text = 's'.repeat(1000)
  const result = await manager.beforeRequest('auto')
  assert.equal(result.status, 'compacted')
  assert.equal(manager.lastSummary, provider.text)
  assert(manager.snapshot().estimatedTokens < before)
  assert.deepEqual(history.view().slice(2), recent)
})

await check('有效短摘要正常提交，只执行一次完成 hook，之后不再请求摘要', async () => {
  const hooks = new HookEngine([])
  const events: string[] = []
  hooks.fire = async (event) => { events.push(event) }
  const { history, provider, manager, actions } = fixture(hooks)
  const recent = history.all().slice(-5)
  manager.afterRequest(5100, history.length)
  provider.text = '保留关键事项的简短摘要'
  assert.equal(await actions.compact(), '压缩完成：早期对话已摘要')
  assert.deepEqual(events, ['pre_compact', 'post_compact'])
  assert.deepEqual(history.view().slice(2), recent)
  assert.equal(manager.lastSummary, provider.text)
  assert.equal(manager.snapshot().estimatedTokens, tokens(history.view()))
  assert(manager.snapshot().estimatedTokens < 1000)
  assert.deepEqual(await manager.beforeRequest('auto'), { status: 'skipped', reason: 'below_threshold' })
  assert.equal(provider.requests, 1)
})

await check('并发无收益摘要只计一次失败，手动有效压缩解除暂停并重置失败数', async () => {
  const { history, provider, manager } = fixture()
  const original = history.all()
  const started = deferred()
  const gate = deferred()
  provider.onRequest = async () => { started.resolve(); await gate.promise }
  const requests = [manager.beforeRequest('auto'), manager.beforeRequest('manual'), manager.beforeRequest('auto')]
  try {
    await bounded(started.promise)
  } finally {
    gate.resolve()
  }
  const results = await bounded(Promise.all(requests))
  assert(results.every((result) => result.status === 'failed'))
  assert.equal(provider.requests, 1)
  assert(!manager.breakerOpenState)
  assert.deepEqual(history.view(), original)
  assert.equal((await manager.beforeRequest('auto')).status, 'failed')
  assert(!manager.breakerOpenState)
  assert.equal((await manager.beforeRequest('auto')).status, 'failed')
  assert(manager.breakerOpenState)
  provider.text = '手动重试后的有效摘要'
  assert.equal((await manager.compact()).status, 'compacted')
  assert(!manager.breakerOpenState)
  assert.equal(provider.requests, 4)
  for (const message of original) history.push(message)
  provider.text = 's'.repeat(16000)
  assert.equal((await manager.beforeRequest('auto')).status, 'failed')
  assert.equal((await manager.beforeRequest('auto')).status, 'failed')
  assert(!manager.breakerOpenState)
})

await check('摘要等待期间追加的消息完整保留，无收益结果不改写预算和历史', async () => {
  const { history, provider, manager } = fixture()
  manager.afterRequest(4100, history.length)
  const started = deferred()
  const gate = deferred()
  provider.onRequest = async () => { started.resolve(); await gate.promise }
  const pending = manager.beforeRequest('auto')
  let expected: ChatMessage[] = []
  let version = 0
  try {
    await bounded(started.promise)
    history.push({ role: 'user', content: '摘要期间追加的新任务' })
    expected = history.all()
    version = history.version
  } finally {
    gate.resolve()
  }
  assert.equal((await bounded(pending)).status, 'failed')
  assert.deepEqual(history.view(), expected)
  assert.equal(history.version, version)
  assert.equal(manager.snapshot().estimatedTokens, 4100 + estimateMessageTokens(expected.at(-1)!))
})

console.log(`\ncontext_compaction_gain_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
