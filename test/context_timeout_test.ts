import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { setTimeout as pause } from 'node:timers/promises'
import { ContextManager, summarize } from '../src/context/index.ts'
import { AnthropicProvider } from '../src/provider/anthropic.ts'
import { OpenAIProvider } from '../src/provider/openai.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { createSessionActions } from '../src/tui/session-actions.ts'

let passed = 0
let failed = 0
const messages = [{ role: 'user' as const, content: '早期内容' }]

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

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('测试等待超时')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

for (const protocol of ['openai', 'anthropic'] as const) {
  const config = { name: 'test', protocol, model: 'test', base_url: 'https://summary.invalid', api_key: 'test' }
  const provider = protocol === 'openai' ? new OpenAIProvider(config) : new AnthropicProvider(config)

  await check(`${protocol}: 持续输出仍按摘要总期限超时，取消响应流并拒绝部分文本`, async () => {
    const fetch = globalThis.fetch
    const parent = new AbortController()
    let interval: ReturnType<typeof setInterval> | undefined
    let cancelled = false
    let chunks = 0
    const data = protocol === 'openai'
      ? { choices: [{ delta: { content: '部分摘要' } }] }
      : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分摘要' } }
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        chunks++
        interval = setInterval(() => { controller.enqueue(chunk); chunks++ }, 5)
      },
      cancel() {
        cancelled = true
        clearInterval(interval)
      },
    })
    globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    try {
      await assert.rejects(bounded(summarize(provider, messages, {
        cwd: process.cwd(), timeoutMs: 50, signal: parent.signal,
      })), /摘要超时（0\.05s）/)
      assert(chunks >= 2)
      assert(cancelled)
      assert(!parent.signal.aborted)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    } finally {
      parent.abort()
      clearInterval(interval)
      globalThis.fetch = fetch
    }
  })

  await check(`${protocol}: 等待响应头期间超时取消 fetch`, async () => {
    const fetch = globalThis.fetch
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = async (_, init) => new Promise<Response>((_, reject) => {
      requestSignal = init?.signal ?? undefined
      assert(requestSignal)
      requestSignal.addEventListener('abort', () => reject(new Error('fetch 已取消')), { once: true })
    })
    try {
      await assert.rejects(bounded(summarize(provider, messages, {
        cwd: process.cwd(), timeoutMs: 20, signal: parent.signal,
      })), /摘要超时（0\.02s）/)
      assert(requestSignal?.aborted)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    } finally {
      parent.abort()
      globalThis.fetch = fetch
    }
  })
}

await check('预先取消时不启动摘要请求', async () => {
  const parent = new AbortController()
  parent.abort()
  let requests = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(): AsyncGenerator<StreamEvent> { requests++; yield { type: 'text', text: '摘要' } },
  }
  await assert.rejects(summarize(provider, messages, { cwd: process.cwd(), signal: parent.signal }), /摘要已取消/)
  assert.equal(requests, 0)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})

await check('主动取消及时返回，部分摘要不作为成功结果', async () => {
  const parent = new AbortController()
  const waiting = deferred()
  let requestSignal: AbortSignal | undefined
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
      requestSignal = opts.signal
      yield { type: 'text', text: '部分摘要' }
      await new Promise<void>((resolve) => {
        opts.signal!.addEventListener('abort', () => resolve(), { once: true })
        waiting.resolve()
      })
    },
  }
  const request = summarize(provider, messages, { cwd: process.cwd(), timeoutMs: 1000, signal: parent.signal })
  const result = assert.rejects(bounded(request), /摘要已取消/)
  try {
    await bounded(waiting.promise)
    parent.abort()
    await result
    assert(requestSignal?.aborted)
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  } finally {
    parent.abort()
  }
})

await check('供应商忽略取消时仍及时超时，迟到异常被处理', async () => {
  const gate = deferred()
  const finished = deferred()
  let requestSignal: AbortSignal | undefined
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
      requestSignal = opts.signal
      try {
        yield { type: 'text', text: '部分摘要' }
        await gate.promise
        throw new Error('迟到的网络错误')
      } finally {
        finished.resolve()
      }
    },
  }
  try {
    await assert.rejects(bounded(summarize(provider, messages, { cwd: process.cwd(), timeoutMs: 20 })), /摘要超时/)
    assert(requestSignal?.aborted)
  } finally {
    gate.resolve()
    await bounded(finished.promise)
  }
})

await check('成功或供应商失败后清理计时器和取消监听', async () => {
  for (const fail of [false, true]) {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
        requestSignal = opts.signal
        yield { type: 'text', text: '  完整' }
        yield fail ? { type: 'error', message: '原始失败原因' } : { type: 'text', text: '摘要  ' }
      },
    }
    const request = summarize(provider, messages, { cwd: process.cwd(), timeoutMs: 20, signal: parent.signal })
    if (fail) await assert.rejects(request, /摘要请求失败: 原始失败原因/)
    else assert.equal(await request, '完整摘要')
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    parent.abort()
    await pause(40)
    assert(requestSignal && !requestSignal.aborted)
  }
})

await check('默认 60 秒期限生效，手动压缩超时保留原历史和旧摘要且允许重试', async () => {
  const setTimeout = globalThis.setTimeout
  let deadlines = 0
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 60000) deadlines++
    return setTimeout(callback, ms === 60000 ? 20 : ms, ...args)
  }) as typeof globalThis.setTimeout
  let succeed = false
  let requestSignal: AbortSignal | undefined
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(_, opts): AsyncGenerator<StreamEvent> {
      requestSignal = opts.signal
      yield { type: 'text', text: succeed ? '重试摘要' : '部分摘要' }
      if (!succeed) await new Promise<void>((resolve) => opts.signal!.addEventListener('abort', () => resolve(), { once: true }))
    },
  }
  try {
    await assert.rejects(bounded(summarize(provider, messages, { cwd: process.cwd() })), /摘要超时（60s）/)
    assert.equal(deadlines, 1)
    const history = new History()
    for (let index = 0; index < 40; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(500) })
    const original = JSON.stringify(history.view())
    const version = history.version
    const manager = new ContextManager({ provider, history, cwd: process.cwd(), window: 6000, manualMargin: 2000 })
    manager.lastSummary = '旧摘要'
    const actions = createSessionActions({ history, contextManager: manager, isStreaming: () => false, resetUi: () => {}, onSessionChange: () => {} })
    assert.equal(await bounded(actions.compact()), '压缩失败: 摘要超时（60s）')
    assert.equal(JSON.stringify(history.view()), original)
    assert.equal(history.version, version)
    assert.equal(manager.lastSummary, '旧摘要')
    assert(requestSignal?.aborted)
    succeed = true
    assert.equal(await bounded(actions.compact()), '压缩完成：早期对话已摘要')
    assert.equal(manager.lastSummary, '重试摘要')
    assert.equal(history.length, 7)
    assert.equal(deadlines, 3)
  } finally {
    globalThis.setTimeout = setTimeout
  }
})

console.log(`\ncontext_timeout_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
