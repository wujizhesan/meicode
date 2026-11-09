import { EventEmitter } from 'node:events'
import { createA2aSseWriter } from '../src/a2a/sse.ts'
import type { SseCloseReason, SseWritable } from '../src/a2a/sse.ts'
import type { A2AStreamResponse } from '../src/a2a/types.ts'

class FakeResponse extends EventEmitter implements SseWritable {
  writableEnded = false
  writableLength = 0
  destroyed = false
  writes: string[] = []
  results: boolean[] = []

  write(chunk: string): boolean {
    this.writes.push(chunk)
    const result = this.results.shift() ?? true
    if (!result) this.writableLength += Buffer.byteLength(chunk)
    return result
  }

  end(): void {
    this.writableEnded = true
    this.emit('close')
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }

  drain(): void {
    this.writableLength = 0
    this.emit('drain')
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const working: A2AStreamResponse = {
  statusUpdate: {
    taskId: 'task-sse',
    contextId: 'ctx-sse',
    status: { state: 'TASK_STATE_WORKING', timestamp: new Date(0).toISOString() },
  },
}
const completed: A2AStreamResponse = {
  statusUpdate: {
    taskId: 'task-sse',
    contextId: 'ctx-sse',
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(0).toISOString() },
    final: true,
  },
}

const normal = new FakeResponse()
let normalReason: SseCloseReason | undefined
const normalWriter = createA2aSseWriter(normal, 7, (reason) => { normalReason = reason })
normalWriter.write(working)
normalWriter.write(completed)
assert(normal.writes.length === 2 && normal.writes[0].includes('"jsonrpc":"2.0"'), '正常 SSE / JSON-RPC 事件未发送')
assert(normal.writableEnded && normalReason === 'complete', '终态 SSE 未正常结束')

const backpressure = new FakeResponse()
backpressure.results = [false, true, true]
let backpressureReason: SseCloseReason | undefined
const backpressureWriter = createA2aSseWriter(backpressure, undefined, (reason) => { backpressureReason = reason })
backpressureWriter.write(working)
backpressureWriter.write(working)
assert(backpressure.writes.length === 1, '背压后仍继续写入响应')
backpressure.drain()
assert(Number(backpressure.writes.length) === 2, 'drain 后未恢复发送')
backpressureWriter.write(completed)
assert(backpressure.writableEnded && backpressureReason === 'complete', '背压恢复后终态事件未送达')

const terminalBlocked = new FakeResponse()
terminalBlocked.results = [false]
let terminalBlockedReason: SseCloseReason | undefined
const terminalBlockedWriter = createA2aSseWriter(terminalBlocked, undefined, (reason) => { terminalBlockedReason = reason })
terminalBlockedWriter.write(completed)
assert(!terminalBlocked.writableEnded, '终态事件遇到背压时提前结束')
terminalBlocked.drain()
assert(terminalBlocked.writableEnded && terminalBlockedReason === 'complete', '终态事件未在 drain 后完成')

const overflow = new FakeResponse()
overflow.results = [false]
const frameBytes = Buffer.byteLength(`data: ${JSON.stringify(working)}\n\n`)
let overflowReason: SseCloseReason | undefined
const overflowWriter = createA2aSseWriter(overflow, undefined, (reason) => { overflowReason = reason }, { maxBufferBytes: frameBytes * 2 + 1 })
overflowWriter.write(working)
overflowWriter.write(working)
overflowWriter.write(working)
assert(overflow.destroyed && overflowReason === 'overflow', '超限慢连接未被断开')
assert(overflow.writes.length === 1 && overflowWriter.isClosed(), '超限后仍继续写入')

const timeout = new FakeResponse()
timeout.results = [false]
let timeoutReason: SseCloseReason | undefined
const timeoutWriter = createA2aSseWriter(timeout, undefined, (reason) => { timeoutReason = reason }, { drainTimeoutMs: 20 })
timeoutWriter.write(working)
await new Promise((resolve) => setTimeout(resolve, 40))
assert(timeout.destroyed && timeoutReason === 'timeout', '未恢复的背压连接未超时断开')

const replay = new FakeResponse()
replay.results = [false]
let replayReason: SseCloseReason | undefined
const replayWriter = createA2aSseWriter(replay, undefined, (reason) => { replayReason = reason })
replayWriter.write(working)
replayWriter.finish()
assert(!replay.writableEnded, '背压中的重放提前结束')
replay.drain()
assert(replay.writableEnded && replayReason === 'complete', '背压重放未在 drain 后结束')

console.log('a2a_sse_test passed')
