import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeEventLog, createRuntimeId } from '../src/runtime/index.ts'

const tmp = join(import.meta.dirname, 'fixtures_runtime')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const id = createRuntimeId('session')
const log = new RuntimeEventLog(tmp)
const first = log.append({ sessionId: id, type: 'run_started', payload: { mode: 'full' } })
const second = log.append({ sessionId: id, type: 'run_finished', payload: { reason: 'complete' } })
const events = log.read(id)

if (first.seq !== 1 || second.seq !== 2) throw new Error('事件序号不连续')
if (events.length !== 2 || events[0].type !== 'run_started' || events[1].type !== 'run_finished') {
  throw new Error('事件读取顺序错误')
}
if (!first.eventId.startsWith('event_')) throw new Error('事件 ID 前缀错误')

const pending = log.waitForEvent(id, 1000)
setTimeout(() => log.append({ sessionId: id, type: 'tool_call', payload: { name: 'wait_test' } }), 10)
const received = await pending
if (!received || received.type !== 'tool_call') throw new Error('事件等待未被唤醒')

const externalLog = new RuntimeEventLog(tmp)
const externalPending = log.waitForEvent(id, 1000)
setTimeout(() => externalLog.append({ sessionId: id, type: 'message_sent', payload: { source: 'external-instance' } }), 10)
const externalReceived = await externalPending
if (!externalReceived || externalReceived.type !== 'message_sent') throw new Error('跨实例事件等待未唤醒')

const rotatedId = createRuntimeId('session')
const rotatedLog = new RuntimeEventLog(tmp, { maxBytes: 1024 })
for (let i = 0; i < 6; i++) rotatedLog.append({ sessionId: rotatedId, type: 'tool_result', payload: { text: 'x'.repeat(500) } })
const rotatedEvents = rotatedLog.read(rotatedId)
if (rotatedEvents.length !== 6 || rotatedEvents[5].seq !== 6) throw new Error('事件轮转后读取或序号错误')
if (!readdirSync(tmp).some((name) => name.includes(`${rotatedId}.segment-`))) throw new Error('事件日志未轮转')
const reopened = new RuntimeEventLog(tmp, { maxBytes: 1024 })
if (reopened.append({ sessionId: rotatedId, type: 'run_finished' }).seq !== 7) throw new Error('索引未恢复序号')
writeFileSync(join(tmp, `${rotatedId}.index.json`), '{broken', 'utf8')
const recoveredIndex = new RuntimeEventLog(tmp, { maxBytes: 1024 })
if (recoveredIndex.append({ sessionId: rotatedId, type: 'report_ready' }).seq !== 8) throw new Error('索引损坏后未恢复序号')

const escapedFile = join(tmp, 'evil.jsonl')
writeFileSync(escapedFile, JSON.stringify({ sessionId: rotatedId, type: 'tool_result', eventId: 'event_evil', seq: 999, ts: Date.now() }) + '\n', 'utf8')
writeFileSync(join(tmp, `${rotatedId}.index.json`), JSON.stringify({ lastSeq: 8, segments: ['../evil.jsonl'] }), 'utf8')
if (recoveredIndex.read(rotatedId).some((event) => event.seq === 999)) throw new Error('损坏索引越界读取了外部日志')

const collisionLog = new RuntimeEventLog(tmp)
collisionLog.append({ sessionId: 'a/b', type: 'message_sent', payload: { source: 'slash' } })
collisionLog.append({ sessionId: 'a_b', type: 'message_sent', payload: { source: 'underscore' } })
if (collisionLog.read('a/b').length !== 1 || collisionLog.read('a_b').length !== 1) throw new Error('不同 session id 发生文件碰撞')

console.log('runtime_test passed')
