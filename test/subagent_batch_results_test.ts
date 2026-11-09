import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { SessionStore } from '../src/memory/index.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { bounded, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
type Fixture = Awaited<ReturnType<typeof streamFixture>>
const reports = (messages: readonly ChatMessage[]) => messages.filter((message) => message.role === 'system' && message.content.startsWith('[子任务报告 '))
const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'text', text: 'PARENT-DONE' }; yield { type: 'done' } } }
function seed(f: Fixture, count: number, sessionId = f.memory.sessionId) {
  const store = f.subStore.forSession(sessionId)
  const tasks = Array.from({ length: count }, (_, index) => ({ id: sessionId + '-agent-' + index, reportId: sessionId + '-report-' + index }))
  for (const task of tasks) store.save({ ...task, role: 'worker', type: 'fork', status: 'done', startedAt: Date.now(), sessionId,
    parentAgentId: f.chat.getToolContext().agentId, result: 'BATCH-RESULT-' + task.id })
  return tasks
}
function track(f: Fixture) {
  const append = f.store.append.bind(f.store), replace = f.store.replace.bind(f.store)
  const writes = { appends: 0, reportAppends: 0, replacements: 0, messageBytes: 0 }
  f.store.append = (...args: Parameters<typeof append>) => {
    writes.appends++
    if (reports(args[1]).length > 0) writes.reportAppends++
    writes.messageBytes += Buffer.byteLength(args[1].map((message) => JSON.stringify(message)).join('\n') + '\n')
    return append(...args)
  }
  f.store.replace = (...args: Parameters<typeof replace>) => { writes.replacements++; return replace(...args) }
  return { writes, restore() { f.store.append = append; f.store.replace = replace } }
}
function restoreBase(f: Fixture, large = false) {
  const base: ChatMessage[] = Array.from({ length: large ? 24 : 2 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: 'BASE-' + index + (large ? '\n' + 'x'.repeat(16000) : ''),
  }))
  f.store.replace(f.memory.sessionId, base)
  assert.match(f.chat.resume(f.memory.sessionId), /已恢复会话/)
  return base
}
const saved = (f: Fixture, id = f.memory.sessionId) => new SessionStore(join(f.root, 'sessions')).recoverById(id)!.messages

for (const mode of ['restore', 'send', 'periodic']) await check(mode + ' 批量报告合并在一次追加中保存，收据和去重正确', async () => {
  const requests: ChatMessage[][] = []
  const capture: Provider = { protocol: 'openai', async *streamChat(messages) {
    requests.push(structuredClone(messages)); yield { type: 'text', text: 'PARENT-DONE' }; yield { type: 'done' }
  } }
  const f = await streamFixture(capture)
  let trace: ReturnType<typeof track> | undefined
  try {
    const base = restoreBase(f, mode === 'periodic')
    trace = track(f)
    const tasks = seed(f, 24)
    if (mode === 'restore') assert.match(f.chat.resume(f.memory.sessionId), /已恢复会话/)
    else if (mode === 'send') {
      await bounded(f.chat.send('PARENT-FOLLOW-UP'))
      assert.equal(reports(requests.at(-1)!).length, 24)
    } else {
      const deadline = performance.now() + 6500
      while (reports(f.history.view()).length !== 24) {
        if (performance.now() >= deadline) throw new Error('周期批量同步超时')
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
    }
    assert.equal(trace.writes.reportAppends, 1)
    if (mode !== 'send') assert.equal(trace.writes.appends, 1)
    assert.equal(trace.writes.replacements, 0)
    assert(trace.writes.messageBytes < 10000)
    assert.deepEqual(f.history.view().slice(0, base.length), base)
    assert.deepEqual(saved(f), f.history.view())
    for (const task of tasks) assert(f.store.hasReportReceipt(f.memory.sessionId, task.reportId))
    await tick(); await tick()
    assert.equal(f.chat.messages.filter((message) => message.role === 'tool' && message.text.includes('BATCH-RESULT-')).length, 24)
    const beforeRemount = { ...trace.writes }
    await f.remount()
    assert.equal(f.chat.messages.length, 0)
    assert.equal(reports(f.history.view()).length, 24)
    assert.deepEqual(trace.writes, beforeRemount)
    if (mode === 'periodic') console.log('    24 次全量重写减少为 1 次追加，增量消息 ' + trace.writes.messageBytes + ' bytes')
  } finally { trace?.restore(); await f.close() }
})

await check('批量追加失败保留内存结果，恢复后一次补存且不重复报告', async () => {
  const f = await streamFixture(provider)
  const append = f.store.append.bind(f.store)
  let trace: ReturnType<typeof track> | undefined
  try {
    const base = restoreBase(f), tasks = seed(f, 6)
    let attempts = 0
    f.store.append = () => { attempts++; throw new Error('BATCH-SAVE-FAILED') }
    assert.match(f.chat.resume(f.memory.sessionId), /已恢复会话/)
    assert.equal(attempts, 1)
    assert.equal(reports(f.history.view()).length, 6)
    assert.deepEqual(saved(f), base)
    for (const task of tasks) assert.equal(f.store.hasReportReceipt(f.memory.sessionId, task.reportId), false)
    f.store.append = append
    trace = track(f)
    await bounded(f.chat.send('RETRY-SAVE'))
    assert.equal(trace.writes.reportAppends, 1)
    assert.equal(trace.writes.replacements, 0)
    assert.equal(reports(f.history.view()).length, 6)
    assert.deepEqual(saved(f), f.history.view())
    for (const task of tasks) assert(f.store.hasReportReceipt(f.memory.sessionId, task.reportId))
    await f.remount()
    assert.equal(f.chat.messages.length, 0)
  } finally { trace?.restore(); f.store.append = append; await f.close() }
})

await check('批量回流遇到并发更新只创建一份完整冲突副本，保留原外部内容', async () => {
  const f = await streamFixture(provider)
  let trace: ReturnType<typeof track> | undefined
  try {
    restoreBase(f)
    const original = f.memory.sessionId, tasks = seed(f, 8)
    new SessionStore(join(f.root, 'sessions')).append(original, [{ role: 'user', content: 'EXTERNAL-WRITE' }])
    trace = track(f)
    await f.remount()
    assert.notEqual(f.memory.sessionId, original)
    assert.equal(saved(f, original).at(-1)?.content, 'EXTERNAL-WRITE')
    assert.equal(reports(saved(f)).length, 8)
    assert.deepEqual(saved(f), f.history.view())
    assert(!JSON.stringify(f.history.view()).includes('EXTERNAL-WRITE'))
    assert.equal(trace.writes.appends, 1)
    assert.equal(new SessionStore(join(f.root, 'sessions')).listSessions(20).filter((session) => session.id.startsWith(original + '-conflict-')).length, 1)
    for (const task of tasks) assert(f.store.hasReportReceipt(f.memory.sessionId, task.reportId))
  } finally { trace?.restore(); await f.close() }
})

await check('来源存档读错时已读批次仍保存，来源恢复后仅补回明确关联的结果', async () => {
  const f = await streamFixture(provider), source = 'linked-source', file = join(f.root, 'subagents', source + '.json')
  const originalRead = fs.readFileSync
  let trace: ReturnType<typeof track> | undefined
  try {
    const base = restoreBase(f), linked = seed(f, 4, source), current = seed(f, 3)
    new SessionStore(join(f.root, 'sessions')).replace(f.memory.sessionId, base, [], linked.slice(0, 3).map((task) => ({ sessionId: source, agentId: task.id })))
    trace = track(f)
    fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
      if (String(path) === file) throw Object.assign(new Error('SOURCE-READ-DENIED'), { code: 'EACCES' })
      return (originalRead as (...params: unknown[]) => unknown)(path, ...args)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    assert.match(f.chat.resume(f.memory.sessionId), /已恢复会话/)
    fs.readFileSync = originalRead; syncBuiltinESMExports()
    assert.equal(trace.writes.appends, 1)
    assert.equal(reports(saved(f)).length, 3)
    assert(fs.existsSync(file))
    assert(!fs.readdirSync(join(f.root, 'subagents')).some((name) => name.startsWith(source + '.json.corrupt.')))
    await tick(); await tick()
    assert(f.chat.messages.some((message) => message.text.includes('SOURCE-READ-DENIED')))
    await bounded(f.chat.send('SOURCE-RETRY'))
    assert.equal(reports(saved(f)).length, 6)
    for (const task of [...current, ...linked.slice(0, 3)]) assert(f.store.hasReportReceipt(f.memory.sessionId, task.reportId))
    assert.equal(f.store.hasReportReceipt(f.memory.sessionId, linked[3].reportId), false)
    assert(!JSON.stringify(f.history.view()).includes('BATCH-RESULT-' + linked[3].id))
    assert.deepEqual(saved(f), f.history.view())
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); trace?.restore(); await f.close() }
})

console.log('subagent_batch_results_test: ' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
