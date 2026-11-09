import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { ContextManager } from '../src/context/index.ts'
import { HookEngine } from '../src/hook/engine.ts'
import { SessionStore } from '../src/memory/index.ts'
import { OpenAIProvider } from '../src/provider/openai.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('重置后仍在等待旧压缩')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function largeHistory(prefix = '旧会话'): History {
  const history = new History()
  for (let index = 0; index < 40; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `${prefix}_${index}:` + 'x'.repeat(500) })
  return history
}

const root = mkdtempSync(join(tmpdir(), 'meicode-context-reset-'))
// 目录守卫放在创建处：若留在 finally 里抛错，会遮蔽真正的断言失败原因
if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('meicode-context-reset-')) {
  throw new Error('测试目录超出临时目录范围')
}
const store = new SessionStore(join(root, 'sessions'))
const savedMessages = largeHistory('恢复会话').all()
store.append('saved', savedMessages)

function fixture(provider: Provider, hooks?: HookEngine) {
  const history = largeHistory()
  const manager = new ContextManager({ provider, history, hooks, cwd: root, window: 6000, autoMargin: 2000, manualMargin: 2000, sessionId: 'old' })
  const actions = createSessionActions({
    history, contextManager: manager, memory: { sessionId: 'old', sessionStore: store },
    isStreaming: () => false, resetUi: () => {}, onSessionChange: (id) => manager.setSessionId(id),
  })
  return { history, manager, actions }
}

const staleMessage = '压缩已取消：会话或历史已变化，请重试'
const actual = new OpenAIProvider({ name: 'test', protocol: 'openai', model: 'test', api_key: 'test', base_url: 'https://summary.invalid' })

try {
  for (const change of ['clear', 'new', 'resume'] as const) {
    await check(`${change}: 会话重置取消实际供应商响应流，及时返回且保留新历史`, async () => {
      const fetch = globalThis.fetch
      const reading = deferred()
      const finished = deferred()
      let interval: ReturnType<typeof setInterval> | undefined
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
      let cancelled = false
      let summarySignal: AbortSignal | undefined
      const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分摘要' } }] })}\n\n`)
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
          controller.enqueue(chunk)
          interval = setInterval(() => controller.enqueue(chunk), 5)
        },
        cancel() {
          cancelled = true
          clearInterval(interval)
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
      const provider: Provider = {
        protocol: 'openai',
        async *streamChat(messages, opts): AsyncGenerator<StreamEvent> {
          summarySignal = opts.signal
          try {
            for await (const event of actual.streamChat(messages, opts)) {
              if (event.type === 'text') reading.resolve()
              yield event
            }
          } finally {
            finished.resolve()
          }
        },
      }
      const { actions, history, manager } = fixture(provider)
      const request = actions.compact()
      try {
        await bounded(reading.promise)
        if (change === 'clear') actions.clearHistory()
        else if (change === 'new') assert.equal(actions.newSession(), '已新建会话')
        else assert.match(actions.resume('saved'), /40 条消息/)
        const expected = change === 'resume' ? JSON.stringify(savedMessages) : '[]'
        const version = history.version
        assert.equal(await bounded(request), staleMessage)
        await bounded(finished.promise)
        assert(summarySignal?.aborted)
        assert(cancelled)
        assert.equal(JSON.stringify(history.view()), expected)
        assert.equal(history.version, version)
        assert.equal(manager.lastSummary, null)
        assert(!manager.breakerOpenState)
      } finally {
        manager.reset()
        clearInterval(interval)
        try { bodyController?.close() } catch {}
        await bounded(request)
        globalThis.fetch = fetch
      }
    })
  }

  await check('等待响应头时会话重置也中止 fetch', async () => {
    const fetch = globalThis.fetch
    const started = deferred()
    const finished = deferred()
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = async (_, opts) => new Promise<Response>((_, reject) => {
      requestSignal = opts?.signal ?? undefined
      assert(requestSignal)
      requestSignal.addEventListener('abort', () => reject(new Error('fetch 已取消')), { once: true })
      started.resolve()
    })
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages, opts): AsyncGenerator<StreamEvent> {
        try { yield* actual.streamChat(messages, opts) }
        finally { finished.resolve() }
      },
    }
    const { actions, manager, history } = fixture(provider)
    const request = actions.compact()
    try {
      await bounded(started.promise)
      actions.newSession()
      assert.equal(await bounded(request), staleMessage)
      await bounded(finished.promise)
      assert(requestSignal?.aborted)
      assert.equal(history.length, 0)
      assert(!manager.breakerOpenState)
    } finally {
      manager.reset()
      await bounded(request)
      globalThis.fetch = fetch
    }
  })

  for (const lateResponse of ['success', 'error'] as const) {
    await check(`供应商忽略取消并迟到 ${lateResponse}，不会清除或覆盖新压缩`, async () => {
      const starts = [deferred(), deferred()]
      const gates = [deferred(), deferred()]
      const finishes = [deferred(), deferred()]
      const signals: (AbortSignal | undefined)[] = []
      let requests = 0
      const provider: Provider = {
        protocol: 'openai',
        async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
          const index = requests++
          if (index > 1) { yield { type: 'text', text: '错误的重复请求' }; return }
          signals[index] = opts.signal
          starts[index].resolve()
          try {
            await gates[index].promise
            if (index === 0 && lateResponse === 'error') throw new Error('旧供应商迟到异常')
            yield { type: 'text', text: index === 0 ? '旧摘要' : '新摘要' }
          } finally {
            finishes[index].resolve()
          }
        },
      }
      const { actions, manager, history } = fixture(provider)
      const oldRequests = [actions.compact(), actions.compact()]
      const newRequests: Promise<string>[] = []
      try {
        await bounded(starts[0].promise)
        actions.newSession()
        assert.deepEqual(await bounded(Promise.all(oldRequests)), [staleMessage, staleMessage])
        assert(signals[0]?.aborted)
        for (const message of largeHistory('新会话').view()) history.push(message)
        const recent = history.all().slice(-5)
        newRequests.push(actions.compact())
        await bounded(starts[1].promise)
        gates[0].resolve()
        await bounded(finishes[0].promise)
        assert(signals[1] && !signals[1].aborted)
        newRequests.push(actions.compact())
        gates[1].resolve()
        assert.deepEqual(await bounded(Promise.all(newRequests)), ['压缩完成：早期对话已摘要', '压缩完成：早期对话已摘要'])
        assert.equal(requests, 2)
        assert.equal(manager.lastSummary, '新摘要')
        assert.deepEqual(history.view().slice(2), recent)
        assert(!manager.breakerOpenState)
      } finally {
        manager.reset()
        for (const gate of gates) gate.resolve()
        await bounded(Promise.all([...oldRequests, ...newRequests]))
      }
    })
  }

  await check('会话重置唤醒自动与手动等待者，清理外部监听且不取消父任务', async () => {
    const started = deferred()
    const gate = deferred()
    const finished = deferred()
    let summarySignal: AbortSignal | undefined
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
        summarySignal = opts.signal
        started.resolve()
        try { await gate.promise; yield { type: 'text', text: '迟到摘要' } }
        finally { finished.resolve() }
      },
    }
    const { actions, manager, history } = fixture(provider)
    const parent = new AbortController()
    const owner = manager.beforeRequest('auto', parent.signal)
    try {
      await bounded(started.promise)
      const waiter = manager.beforeRequest('manual', parent.signal)
      const manual = actions.compact()
      actions.clearHistory()
      await bounded(Promise.all([owner, waiter]))
      assert.equal(await bounded(manual), staleMessage)
      assert(summarySignal?.aborted)
      assert(!parent.signal.aborted)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      assert.equal(history.length, 0)
    } finally {
      manager.reset()
      gate.resolve()
      await bounded(finished.promise)
      await bounded(owner)
    }
  })

  await check('pre_compact 等待中重置及时返回，迟到 Hook 异常不影响新会话', async () => {
    const started = deferred()
    const gate = deferred()
    const finished = deferred()
    const hooks = new HookEngine([])
    let first = true
    let requests = 0
    hooks.fire = async (event) => {
      if (event === 'pre_compact' && first) {
        first = false
        started.resolve()
        try { await gate.promise; throw new Error('旧 Hook 迟到异常') }
        finally { finished.resolve() }
      }
    }
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(): AsyncGenerator<StreamEvent> { requests++; yield { type: 'text', text: '新摘要' } },
    }
    const { actions, manager, history } = fixture(provider, hooks)
    const oldRequest = actions.compact()
    try {
      await bounded(started.promise)
      actions.newSession()
      assert.equal(await bounded(oldRequest), staleMessage)
      assert.equal(requests, 0)
      for (const message of largeHistory('新会话').view()) history.push(message)
      assert.equal(await bounded(actions.compact()), '压缩完成：早期对话已摘要')
      const expected = JSON.stringify(history.view())
      gate.resolve()
      await bounded(finished.promise)
      assert.equal(JSON.stringify(history.view()), expected)
      assert.equal(manager.lastSummary, '新摘要')
      assert.equal(requests, 1)
      assert(!manager.breakerOpenState)
    } finally {
      manager.reset()
      gate.resolve()
      await bounded(oldRequest)
    }
  })

  await check('请求尚未启动就重置，旧请求不发摘要且不清除新请求', async () => {
    let requests = 0
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(): AsyncGenerator<StreamEvent> { requests++; yield { type: 'text', text: '新摘要' } },
    }
    const { manager, history } = fixture(provider)
    const oldRequest = manager.compact()
    manager.reset()
    const newRequest = manager.compact()
    assert.equal((await bounded(oldRequest)).status, 'stale')
    assert.equal((await bounded(newRequest)).status, 'compacted')
    assert.equal(requests, 1)
    assert.equal(history.length, 7)
    assert.equal(manager.lastSummary, '新摘要')
  })

  await check('正常成功和失败后清理自有控制器的父信号监听', async () => {
    for (const fail of [false, true]) {
      let summarySignal: AbortSignal | undefined
      const provider: Provider = {
        protocol: 'openai',
        async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
          summarySignal = opts.signal
          yield fail ? { type: 'error', message: '供应商错误' } : { type: 'text', text: '完整摘要' }
        },
      }
      const { manager, history } = fixture(provider)
      const parent = new AbortController()
      await bounded(manager.beforeRequest('auto', parent.signal))
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      assert.equal(history.length, fail ? 40 : 7)
      parent.abort()
      manager.reset()
      assert(summarySignal && !summarySignal.aborted)
    }
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\ncontext_reset_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
