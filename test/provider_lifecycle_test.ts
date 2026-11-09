import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { runAgent } from '../src/agent/loop.ts'
import type { AgentHandle } from '../src/agent/events.ts'
import { OpenAIProvider } from '../src/provider/openai.ts'
import { AnthropicProvider } from '../src/provider/anthropic.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('流未及时结束')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function response(chunks: string[], close = false, status = 200, cancel?: () => void | Promise<void>) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancellations = 0
  const reading = deferred()
  const body = new ReadableStream<Uint8Array>({
    start(source) {
      controller = source
      for (const chunk of chunks) source.enqueue(new TextEncoder().encode(chunk))
      if (close) source.close()
    },
    pull() { reading.resolve() },
    cancel() { cancellations++; return cancel?.() },
  }, { highWaterMark: 0 })
  return {
    response: new Response(body, { status }), body, reading,
    get cancellations() { return cancellations },
    error() { controller.error(new Error('完成后的连接错误')) },
  }
}

async function withFetch<T>(sources: ReturnType<typeof response>[], run: (signals: AbortSignal[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const signals: AbortSignal[] = []
  let calls = 0
  globalThis.fetch = async (_, init) => {
    assert(init?.signal)
    signals.push(init.signal)
    const source = sources[calls++]
    assert(source, '发生了额外模型请求')
    return source.response
  }
  try { return await run(signals) }
  finally { globalThis.fetch = original; for (const source of sources) source.error() }
}

function fixture(provider: Provider, parent: AbortController, registry = new ToolRegistry()) {
  const history = new History()
  history.push({ role: 'user', content: '测试流生命周期' })
  const agent = runAgent({
    provider, history, registry, signal: parent.signal, ctx: { cwd: process.cwd() },
    maxIterations: 3, mode: 'full', unknownToolLimit: 2, systemPrompt: '测试',
  })
  return { agent, history }
}

async function finish(agent: AgentHandle) {
  try { return await bounded(agent.done) }
  finally { agent.cancel(); await bounded(agent.done) }
}

async function collect(provider: Provider, signal: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.streamChat([{ role: 'user', content: '测试' }], { signal })) events.push(event)
  return events
}

function released(source: ReturnType<typeof response>, signals: AbortSignal[], parent: AbortController) {
  assert.equal(source.body.locked, false)
  assert.equal(source.cancellations, 1)
  assert(signals.every((signal) => signal.aborted))
  assert.equal(parent.signal.aborted, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
}

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const protocols = [
  {
    name: 'OpenAI',
    create: () => new OpenAIProvider({ name: 'test', protocol: 'openai', model: 'test', api_key: 'test', base_url: 'http://localhost/unused' }),
    text: (text: string) => sse({ choices: [{ delta: { content: text } }] }),
    end: 'data: [DONE]\n\n',
    error: sse({ error: { message: 'MODEL_OVERLOADED' } }),
    usage: sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } }),
    tools: [
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"example.ts"}' } }] } }] }),
    ],
  },
  {
    name: 'Anthropic',
    create: () => new AnthropicProvider({ name: 'test', protocol: 'anthropic', model: 'test', api_key: 'test', base_url: 'http://localhost/unused' }),
    text: (text: string) => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    end: sse({ type: 'message_stop' }),
    error: sse({ type: 'error', error: { message: 'MODEL_OVERLOADED' } }),
    usage: sse({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 7 } } }) + sse({ type: 'message_delta', usage: { output_tokens: 4 } }),
    tools: [
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'read-1', name: 'read_file' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"example.ts"}' } }),
    ],
  },
]

for (const protocol of protocols) {
  await check(`${protocol.name}: 完成标记后连接保持打开，Agent 及时保存回答且忽略迟到错误`, async () => {
    const source = response([protocol.text('完整回答') + protocol.end])
    const parent = new AbortController()
    await withFetch([source], async (signals) => {
      const { agent, history } = fixture(protocol.create(), parent)
      const result = await finish(agent)
      assert.equal(result.reason, 'complete')
      assert.equal(result.finalText, '完整回答')
      assert.deepEqual(history.view().at(-1), { role: 'assistant', content: '完整回答' })
      source.error()
      assert.equal((await agent.done).reason, 'complete')
      released(source, signals, parent)
    })
  })

  await check(`${protocol.name}: 保留末尾用量并忽略同一数据块里的重复完成及迟到事件`, async () => {
    const source = response([protocol.text('回答') + protocol.usage + protocol.end + protocol.error + protocol.text('不应出现') + protocol.end])
    const parent = new AbortController()
    await withFetch([source], async (signals) => {
      const events = await bounded(collect(protocol.create(), parent.signal))
      assert.equal(events.filter((event) => event.type === 'done').length, 1)
      assert.equal(events.filter((event) => event.type === 'error').length, 0)
      assert.deepEqual(events.filter((event) => event.type === 'text'), [{ type: 'text', text: '回答' }])
      const usages = events.filter((event) => event.type === 'usage')
      assert.equal(usages.reduce((sum, event) => sum + event.inputTokens, 0), 10)
      assert.equal(usages.reduce((sum, event) => sum + event.outputTokens, 0), 4)
      assert.equal(usages[0].cacheHitTokens, 3)
      released(source, signals, parent)
    })
  })

  await check(`${protocol.name}: 工具参数跨块聚合，完成后只执行一次并进入下一轮`, async () => {
    const source = response([...protocol.tools, protocol.end])
    const final = response([protocol.text('工具完成') + protocol.end])
    const parent = new AbortController()
    const registry = new ToolRegistry()
    let executions = 0
    registry.register({
      name: 'read_file', description: '读取', parameters: { type: 'object' },
      async execute(args) { executions++; assert.deepEqual(args, { path: 'example.ts' }); return { success: true, output: '文件内容' } },
    })
    await withFetch([source, final], async (signals) => {
      const { agent, history } = fixture(protocol.create(), parent, registry)
      const result = await finish(agent)
      assert.equal(result.reason, 'complete')
      assert.equal(result.rounds, 2)
      assert.equal(result.finalText, '工具完成')
      assert.equal(executions, 1)
      assert.equal(history.view().filter((message) => message.role === 'tool').length, 1)
      released(source, signals, parent)
      released(final, signals, parent)
    })
  })

  await check(`${protocol.name}: 缺少完成标记的 EOF 报错，不把半截回答保存为成功`, async () => {
    const source = response([protocol.text('未完成回答')], true)
    const parent = new AbortController()
    await withFetch([source], async (signals) => {
      const { agent, history } = fixture(protocol.create(), parent)
      const result = await finish(agent)
      assert.equal(result.reason, 'error')
      assert.match(result.errorMessage ?? '', /未收到完成标记/)
      assert.equal(result.finalText, '')
      assert(!history.view().some((message) => message.role === 'assistant'))
      assert.equal(source.body.locked, false)
      assert(signals[0].aborted)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    })
  })

  await check(`${protocol.name}: EOF 处完整结束标记缺少末尾空行时仍正常完成`, async () => {
    for (const newline of ['', '\n', '\r\n']) {
      const source = response([protocol.text('完整回答'), ...protocol.tools, protocol.end.trimEnd() + newline], true)
      const parent = new AbortController()
      await withFetch([source], async (signals) => {
        const events = await bounded(collect(protocol.create(), parent.signal))
        assert.equal(events.at(-1)?.type, 'done')
        assert(!events.some((event) => event.type === 'error'))
        const calls = events.filter((event) => event.type === 'tool_call')
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].arguments, { path: 'example.ts' })
        assert.equal(source.body.locked, false)
        assert(signals[0].aborted)
        assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      })
    }
  })

  await check(`${protocol.name}: EOF 处截断的结束标记仍报错且不发出工具调用`, async () => {
    const source = response([...protocol.tools, protocol.end.trimEnd().slice(0, -1)], true)
    const parent = new AbortController()
    await withFetch([source], async () => {
      const events = await bounded(collect(protocol.create(), parent.signal))
      assert.deepEqual(events, [{ type: 'error', message: '流意外结束：未收到完成标记' }])
      assert.equal(source.body.locked, false)
    })
  })

  await check(`${protocol.name}: 工具响应断流时不执行已拼好的调用`, async () => {
    const source = response(protocol.tools, true)
    const parent = new AbortController()
    const registry = new ToolRegistry()
    let executions = 0
    registry.register({ name: 'read_file', description: '读取', parameters: { type: 'object' }, async execute() { executions++; return { success: true, output: '不应执行' } } })
    await withFetch([source], async () => {
      const { agent, history } = fixture(protocol.create(), parent, registry)
      const result = await finish(agent)
      assert.equal(result.reason, 'error')
      assert.equal(executions, 0)
      assert.equal(history.view().length, 1)
      assert.equal(source.body.locked, false)
    })
  })

  await check(`${protocol.name}: SSE 错误后连接未关闭也及时报错并释放`, async () => {
    const source = response([protocol.error])
    const parent = new AbortController()
    await withFetch([source], async (signals) => {
      const { agent } = fixture(protocol.create(), parent)
      const result = await finish(agent)
      assert.equal(result.reason, 'error')
      assert.match(result.errorMessage ?? '', /MODEL_OVERLOADED/)
      released(source, signals, parent)
    })
  })

  await check(`${protocol.name}: HTTP 错误正文等待期间取消，Agent 和响应及时结束`, async () => {
    const source = response([], false, 500, () => new Promise<void>(() => {}))
    const parent = new AbortController()
    await withFetch([source], async (signals) => {
      const { agent, history } = fixture(protocol.create(), parent)
      try {
        await bounded(source.reading.promise)
        parent.abort()
        const result = await finish(agent)
        assert.equal(result.reason, 'cancelled')
        assert.equal(history.view().length, 1)
        assert.equal(source.cancellations, 1)
        assert.equal(source.body.locked, false)
        assert(signals[0].aborted)
        assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      } finally { parent.abort(); await finish(agent) }
    })
  })

  await check(`${protocol.name}: 消费方提前退出时释放响应和取消监听`, async () => {
    const source = response([protocol.text('首段')])
    const parent = new AbortController()
    await withFetch([source], async (signals) => {
      for await (const event of protocol.create().streamChat([], { signal: parent.signal })) {
        assert.equal(event.type, 'text')
        break
      }
      released(source, signals, parent)
    })
  })
}

console.log(`\nprovider_lifecycle_test: ${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
