import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeEventLog, createRuntimeId } from '../src/runtime/index.ts'

const tmp = join(import.meta.dirname, 'fixtures_runtime')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const id = createRuntimeId('session')
const log = new RuntimeEventLog(tmp)
const longSessionId = `a2a:${'外部上下文'.repeat(80)}`
const longSessionEvent = log.append({ sessionId: longSessionId, type: 'audit', payload: { source: 'long-id' } })
if (longSessionEvent.seq !== 1 || log.read(longSessionId)[0]?.payload?.source !== 'long-id') {
  throw new Error('超长外部会话 ID 未稳定映射到事件日志文件')
}
const first = log.append({ sessionId: id, type: 'run_started', payload: { mode: 'full' } })
const second = log.append({ sessionId: id, type: 'run_finished', payload: { reason: 'complete' } })
const events = log.read(id)

if (first.seq !== 1 || second.seq !== 2) throw new Error('事件序号不连续')
if (events.length !== 2 || events[0].type !== 'run_started' || events[1].type !== 'run_finished') {
  throw new Error('事件读取顺序错误')
}
if (!first.eventId.startsWith('event_')) throw new Error('事件 ID 前缀错误')
const activeFile = join(tmp, `${id}.jsonl`)
const activeIndex = JSON.parse(readFileSync(join(tmp, `${id}.index.json`), 'utf8')) as { activeBytes?: number }
if (activeIndex.activeBytes !== statSync(activeFile).size) throw new Error('事件索引未记录活动文件大小')
if (log.read(id).length !== 2) throw new Error('重复读取缓存结果错误')
log.append({ sessionId: id, type: 'audit', payload: { source: 'cache-invalidation' } })
if (log.read(id).length !== 3) throw new Error('追加后事件读取缓存未失效')

const pending = log.waitForEvent(id, 1000)
setTimeout(() => log.append({ sessionId: id, type: 'tool_call', payload: { name: 'wait_test' } }), 10)
const received = await pending
if (!received || received.type !== 'tool_call') throw new Error('事件等待未被唤醒')

const externalLog = new RuntimeEventLog(tmp)
const externalPending = log.waitForEvent(id, 1000)
setTimeout(() => externalLog.append({ sessionId: id, type: 'message_sent', payload: { source: 'external-instance' } }), 10)
const externalReceived = await externalPending
if (!externalReceived || externalReceived.type !== 'message_sent') throw new Error('跨实例事件等待未唤醒')

const interleavedId = createRuntimeId('session')
const interleavedA = new RuntimeEventLog(tmp)
const interleavedB = new RuntimeEventLog(tmp)
if (interleavedA.append({ sessionId: interleavedId, type: 'run_started' }).seq !== 1) throw new Error('跨实例首个事件序号错误')
if (interleavedB.append({ sessionId: interleavedId, type: 'tool_call' }).seq !== 2) throw new Error('跨实例第二个事件序号错误')
if (interleavedA.append({ sessionId: interleavedId, type: 'run_finished' }).seq !== 3) throw new Error('缓存实例未识别外部追加')

const rotatingWaitId = createRuntimeId('session')
const rotatingWaitLog = new RuntimeEventLog(tmp, { maxBytes: 1024 })
rotatingWaitLog.append({ sessionId: rotatingWaitId, type: 'tool_result', payload: { text: 'x'.repeat(1200) } })
const rotatingPending = rotatingWaitLog.waitForEvent(rotatingWaitId, 1000)
setTimeout(() => new RuntimeEventLog(tmp, { maxBytes: 1024 }).append({ sessionId: rotatingWaitId, type: 'message_sent', payload: { source: 'after-rotation' } }), 10)
const rotatingReceived = await rotatingPending
if (!rotatingReceived || rotatingReceived.payload?.source !== 'after-rotation') throw new Error('事件日志轮转后外部等待未唤醒')

const partialId = createRuntimeId('session')
const partialPending = new RuntimeEventLog(tmp).waitForEvent(partialId, 1000)
const partialFile = join(tmp, `${partialId}.jsonl`)
const partialBytes = Buffer.from(JSON.stringify({ sessionId: partialId, type: 'message_sent', eventId: 'event_partial', seq: 1, ts: Date.now(), payload: { text: '分段测试' } }) + '\n')
const splitAt = partialBytes.indexOf(Buffer.from('段')) + 1
setTimeout(() => {
  appendFileSync(partialFile, partialBytes.subarray(0, splitAt))
  setTimeout(() => appendFileSync(partialFile, partialBytes.subarray(splitAt)), 10)
}, 10)
const partialReceived = await partialPending
if (!partialReceived || partialReceived.payload?.text !== '分段测试') throw new Error('分段 UTF-8 事件未正确读取')

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

const checkpointId = createRuntimeId('session')
const checkpointed = new RuntimeEventLog(tmp, { checkpointInterval: 32 })
for (let i = 0; i < 5; i++) checkpointed.append({ sessionId: checkpointId, type: 'tool_call', payload: { i } })
const checkpointReopened = new RuntimeEventLog(tmp, { checkpointInterval: 32 })
if (checkpointReopened.append({ sessionId: checkpointId, type: 'run_finished' }).seq !== 6) {
  throw new Error('批量检查点后重启未从事件正文恢复序号')
}

const tailRecoveryId = createRuntimeId('session')
const tailRecoveryLog = new RuntimeEventLog(tmp)
tailRecoveryLog.append({ sessionId: tailRecoveryId, type: 'tool_result', payload: { text: '长'.repeat(70000) } })
appendFileSync(join(tmp, `${tailRecoveryId}.jsonl`), '{bad json}\n')
const tailRecovered = new RuntimeEventLog(tmp).append({ sessionId: tailRecoveryId, type: 'run_finished' })
if (tailRecovered.seq !== 2) throw new Error('超长事件或损坏尾行导致序号恢复错误')

const batchId = createRuntimeId('session')
const batchLog = new RuntimeEventLog(tmp)
const batch = batchLog.appendBatch([
  { sessionId: batchId, type: 'context_snapshot', turn: 1 },
  { sessionId: batchId, type: 'model_request', turn: 1 },
])
if (batch.length !== 2 || batch[0].seq !== 1 || batch[1].seq !== 2) throw new Error('批量事件序号错误')
if (batchLog.read(batchId).map((event) => event.type).join(',') !== 'context_snapshot,model_request') throw new Error('批量事件读取错误')

const unterminatedId = createRuntimeId('session')
const unterminatedEvent = { sessionId: unterminatedId, type: 'audit' as const, eventId: 'event_unterminated', seq: 1, ts: Date.now() }
writeFileSync(join(tmp, `${unterminatedId}.jsonl`), `\n{bad json}\n${JSON.stringify(unterminatedEvent)}`, 'utf8')
const unterminatedEvents = new RuntimeEventLog(tmp).read(unterminatedId)
if (unterminatedEvents.length !== 1 || unterminatedEvents[0].eventId !== 'event_unterminated') {
  throw new Error('事件读取未正确处理空行、坏行或无换行尾行')
}

const invalidShapeId = createRuntimeId('session')
const validShapeEvent = { sessionId: invalidShapeId, type: 'audit' as const, eventId: 'event_valid_shape', seq: 1, ts: Date.now() }
writeFileSync(
  join(tmp, `${invalidShapeId}.jsonl`),
  `null\n42\n{}\n${JSON.stringify({ ...validShapeEvent, seq: 'wrong' })}\n${JSON.stringify(validShapeEvent)}\n`,
  'utf8',
)
const shapeLog = new RuntimeEventLog(tmp)
if (shapeLog.read(invalidShapeId).map((event) => event.eventId).join(',') !== 'event_valid_shape') throw new Error('错误事件结构未被读取过滤')
if (shapeLog.tail(invalidShapeId, { limit: 5 }).map((event) => event.eventId).join(',') !== 'event_valid_shape') throw new Error('错误事件结构未被尾查过滤')
if (shapeLog.append({ sessionId: invalidShapeId, type: 'run_finished' }).seq !== 2) throw new Error('错误事件结构污染了序号恢复')

const filteredId = createRuntimeId('session')
const auditLine = JSON.stringify({ sessionId: filteredId, type: 'audit', eventId: 'event_audit', seq: 1, ts: Date.now() })
const spacedAuditLine = JSON.stringify({ sessionId: filteredId, type: 'audit', eventId: 'event_spaced_audit', seq: 2, ts: Date.now() }).replace('"type":"audit"', '"type" : "audit"')
const falseMarkerLine = JSON.stringify({ sessionId: filteredId, type: 'tool_result', eventId: 'event_false_marker', seq: 3, ts: Date.now(), payload: { text: '"type":"audit"' } })
writeFileSync(join(tmp, `${filteredId}.jsonl`), `${auditLine}\n${spacedAuditLine}\n${falseMarkerLine}\n`, 'utf8')
const filteredEvents = new RuntimeEventLog(tmp).read(filteredId, { type: 'audit' })
if (filteredEvents.map((event) => event.eventId).join(',') !== 'event_audit,event_spaced_audit') {
  throw new Error('事件类型预过滤发生漏读或误收')
}
const filteredTail = new RuntimeEventLog(tmp).tail(filteredId, { type: 'audit', limit: 1 })
if (filteredTail.length !== 1 || filteredTail[0].eventId !== 'event_spaced_audit') throw new Error('事件尾查未返回最新匹配项')

const predicateTailId = createRuntimeId('session')
const predicateTailLog = new RuntimeEventLog(tmp, { maxBytes: 1024 })
for (let i = 1; i <= 6; i++) {
  predicateTailLog.append({
    sessionId: predicateTailId,
    type: i % 2 === 0 ? 'audit' : 'tool_result',
    payload: { kind: i === 2 || i === 6 ? 'target' : 'other', text: 'x'.repeat(600) },
  })
}
let predicateCalls = 0
const predicateTail = predicateTailLog.tail(predicateTailId, {
  type: 'audit',
  limit: 1,
  predicate: (event) => {
    predicateCalls++
    return event.payload?.kind === 'target'
  },
})
if (predicateTail.length !== 1 || predicateTail[0].seq !== 6) throw new Error('事件尾查谓词未返回最新匹配项')
if (predicateCalls !== 1) throw new Error('事件尾查达到 limit 后仍扫描旧事件')
if (predicateTailLog.tail(predicateTailId, { limit: 0 }).length !== 0) throw new Error('事件尾查未处理零 limit')

const chunkedReadId = createRuntimeId('session')
const chunkedText = '中'.repeat(400000)
const chunkedReadFile = join(tmp, `${chunkedReadId}.jsonl`)
writeFileSync(chunkedReadFile, JSON.stringify({ sessionId: chunkedReadId, type: 'audit', eventId: 'event_chunked', seq: 1, ts: Date.now(), payload: { text: chunkedText } }), 'utf8')
const chunkedReadEvents = new RuntimeEventLog(tmp, { maxBytes: 1024 }).read(chunkedReadId)
if (chunkedReadEvents.length !== 1 || chunkedReadEvents[0].payload?.text !== chunkedText) {
  throw new Error('超大事件分块读取未保持 UTF-8 内容')
}
rmSync(chunkedReadFile, { force: true })

const unorderedId = createRuntimeId('session')
writeFileSync(join(tmp, `${unorderedId}.segment-000000000002-1.jsonl`), JSON.stringify({ sessionId: unorderedId, type: 'run_finished', eventId: 'event_second', seq: 2, ts: Date.now() }) + '\n', 'utf8')
writeFileSync(join(tmp, `${unorderedId}.jsonl`), JSON.stringify({ sessionId: unorderedId, type: 'run_started', eventId: 'event_first', seq: 1, ts: Date.now() }) + '\n', 'utf8')
if (new RuntimeEventLog(tmp).read(unorderedId).map((event) => event.seq).join(',') !== '1,2') throw new Error('乱序事件未正确回退排序')

const escapedFile = join(tmp, 'evil.jsonl')
writeFileSync(escapedFile, JSON.stringify({ sessionId: rotatedId, type: 'tool_result', eventId: 'event_evil', seq: 999, ts: Date.now() }) + '\n', 'utf8')
writeFileSync(join(tmp, `${rotatedId}.index.json`), JSON.stringify({ lastSeq: 8, segments: ['../evil.jsonl'] }), 'utf8')
if (recoveredIndex.read(rotatedId).some((event) => event.seq === 999)) throw new Error('损坏索引越界读取了外部日志')

const collisionLog = new RuntimeEventLog(tmp)
collisionLog.append({ sessionId: 'a/b', type: 'message_sent', payload: { source: 'slash' } })
collisionLog.append({ sessionId: 'a_b', type: 'message_sent', payload: { source: 'underscore' } })
if (collisionLog.read('a/b').length !== 1 || collisionLog.read('a_b').length !== 1) throw new Error('不同 session id 发生文件碰撞')

const lockOwnerId = createRuntimeId('session')
const lockOwnerFile = join(tmp, `${lockOwnerId}.lock`)
const lockOwnerLog = new RuntimeEventLog(tmp, { checkpointInterval: 1 })
Object.defineProperty(lockOwnerLog, 'writeIndex', {
  value: () => writeFileSync(lockOwnerFile, JSON.stringify({ owner: 'replacement-owner', ts: Date.now() }), 'utf8'),
})
lockOwnerLog.append({ sessionId: lockOwnerId, type: 'run_finished' })
const replacementLock = JSON.parse(readFileSync(lockOwnerFile, 'utf8')) as { owner?: string }
if (replacementLock.owner !== 'replacement-owner') throw new Error('旧事件锁释放误删了替代锁')
rmSync(lockOwnerFile, { force: true })

const recreatedRoot = join(tmp, 'recreated-root')
const recreatedLog = new RuntimeEventLog(recreatedRoot)
recreatedLog.append({ sessionId: 'recreated', type: 'run_started' })
rmSync(recreatedRoot, { recursive: true, force: true })
const recreated = recreatedLog.append({ sessionId: 'recreated', type: 'run_finished' })
if (recreated.seq !== 1 || recreatedLog.read('recreated').length !== 1) throw new Error('event root was not recreated after deletion')

console.log('runtime_test passed')
