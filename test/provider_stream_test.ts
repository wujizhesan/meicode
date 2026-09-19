import {
  drainToolCalls,
  getResponseErrorDetail,
  linkAbortSignal,
  readResponseStream,
  type ToolCallAccumulator,
} from '../src/provider/stream.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}: ${(error as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

await check('linkAbortSignal: 转发取消并支持解绑', () => {
  const source = new AbortController()
  const linked = linkAbortSignal(source.signal)
  assert(!linked.controller.signal.aborted, '不应提前取消')
  source.abort()
  assert(linked.controller.signal.aborted, '取消信号未转发')

  const detachedSource = new AbortController()
  const detached = linkAbortSignal(detachedSource.signal)
  detached.dispose()
  detachedSource.abort()
  assert(!detached.controller.signal.aborted, '解绑后不应继续转发')
})

await check('linkAbortSignal: 保留预取消状态', () => {
  const source = new AbortController()
  source.abort()
  assert(linkAbortSignal(source.signal).controller.signal.aborted, '预取消状态丢失')
})

await check('getResponseErrorDetail: 限制响应体长度', async () => {
  const detail = await getResponseErrorDetail(new Response('x'.repeat(600), { status: 500 }))
  assert(detail === `HTTP 500: ${'x'.repeat(500)}`, `错误详情异常: ${detail.length}`)
})

await check('getResponseErrorDetail: 长响应提前停止并取消', async () => {
  let pulls = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(1024).fill(120))
    },
    cancel() {
      cancelled = true
    },
  })
  const detail = await getResponseErrorDetail(new Response(stream, { status: 502 }))
  assert(detail === `HTTP 502: ${'x'.repeat(500)}`, `长错误详情异常: ${detail.length}`)
  assert(pulls < 10 && cancelled, `未提前停止响应读取: pulls=${pulls} cancelled=${cancelled}`)
})

await check('getResponseErrorDetail: 小分片保持 UTF-8 边界', async () => {
  const source = '中😀'.repeat(600)
  const bytes = new TextEncoder().encode(source)
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.subarray(offset, offset + 7))
      offset += 7
    },
  })
  const detail = await getResponseErrorDetail(new Response(stream, { status: 500 }))
  assert(detail === `HTTP 500: ${source.slice(0, 500)}`, 'UTF-8 错误详情截断异常')
})

await check('drainToolCalls: 保序解析并清空累加器', () => {
  const calls = new Map<number, ToolCallAccumulator>([
    [2, { args: ['{}'] }],
    [0, { id: 'a', name: 'read', args: ['{"path":', '"a.ts"}'] }],
    [1, { id: 'b', name: 'broken', args: ['{'] }],
  ])
  const events = drainToolCalls(calls)
  assert(events[0]?.type === 'tool_call' && events[0].arguments.path === 'a.ts', '合法调用解析失败')
  assert(events[1]?.type === 'error' && events[2]?.type === 'error', '非法调用未转为错误事件')
  assert(calls.size === 0, '累加器未清空')
})

await check('readResponseStream: 提前退出时释放底层流', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
      controller.enqueue(new Uint8Array([2]))
    },
    cancel() {
      cancelled = true
    },
  })

  for await (const chunk of readResponseStream(stream)) {
    assert(chunk[0] === 1, '首个数据块异常')
    break
  }
  assert(cancelled, '底层流未释放')
})

await check('readResponseStream: 空闲超时取消底层流', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  let error = ''
  try {
    await readResponseStream(stream, undefined, 10).next()
  } catch (e) {
    error = (e as Error).message
  }
  assert(error.includes('流式读取超时'), `超时错误异常: ${error}`)
  assert(cancelled, '超时后底层流未取消')
})

await check('readResponseStream: 消费方处理时间不计入空闲超时', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
      controller.enqueue(new Uint8Array([2]))
      controller.close()
    },
  })
  const iterator = readResponseStream(stream, undefined, 10)
  assert((await iterator.next()).value?.[0] === 1, '首个数据块异常')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert((await iterator.next()).value?.[0] === 2, '消费等待后数据块丢失')
  await iterator.return(undefined)
})

console.log(`\nprovider_stream_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
