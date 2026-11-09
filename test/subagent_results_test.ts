import assert from 'node:assert/strict'
import { HookEngine } from '../src/hook/engine.ts'
import { sanitizeMessages, SessionStore } from '../src/memory/index.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { SubAgentResults } from '../src/tui/subagent-results.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0
let failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${String(error)}`) }
}
const marker = 'DURABLE-CHILD-RESULT'
const reports = (messages: readonly ChatMessage[]) => messages.filter((message) => message.role === 'system' && message.content.startsWith('[子任务报告 '))

for (const partial of [false, true]) await check(`后台模型失败${partial ? '保留部分结果' : '无输出'}，界面和存档显示真实错误`, async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    if (partial) yield { type: 'text', text: 'PARTIAL-CHILD-OUTPUT' }
    yield { type: 'error', message: 'CHILD-PROVIDER-ERROR' }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  try {
    const record = await f.finished(await f.child('失败子任务'))
    assert.equal(record.status, 'error')
    assert(record.reportId)
    const text = f.chat.messages.map((message) => message.text).join('\n')
    assert(text.includes('已失败：CHILD-PROVIDER-ERROR'))
    assert(!text.includes('子任务已完成'))
    assert.equal(text.includes('PARTIAL-CHILD-OUTPUT'), partial)
    assert.equal(reports(f.history.view()).length, 1)
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

await check('子任务启动 Hook 失败也产生有报告 ID 的通知和存档', async () => {
  const hooks = new HookEngine([])
  hooks.fire = async (event) => { if (event === 'subagent_start') throw new Error('CHILD-STARTUP-ERROR') }
  let requests = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() { requests++; yield { type: 'done' } } }
  const f = await streamFixture(provider, { hooks })
  try {
    const record = await f.finished(await f.child('启动失败'))
    assert.equal(record.status, 'error')
    assert(record.reportId)
    assert.equal(requests, 0)
    assert(f.chat.messages.some((message) => message.text.includes('CHILD-STARTUP-ERROR')))
    assert.equal(reports(f.store.recoverById(f.memory.sessionId)!.messages).length, 1)
  } finally { await f.close() }
})

await check('后台取消显示取消原因和部分结果，并将失败状态通知写入主历史', async () => {
  const started = deferred()
  const gate = deferred()
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    yield { type: 'text', text: 'CANCELLED-PARTIAL' }
    started.resolve()
    await resolveOnAbort(gate.promise, options.signal, undefined)
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  try {
    const id = await f.child('取消子任务')
    await bounded(started.promise)
    assert(f.manager.cancel(id))
    const record = await f.finished(id)
    assert.equal(record.status, 'cancelled')
    const text = f.chat.messages.map((message) => message.text).join('\n')
    assert(text.includes('已取消'))
    assert(text.includes('CANCELLED-PARTIAL'))
    assert(!text.includes('已完成'))
    assert.equal(reports(f.history.view()).length, 1)
  } finally { gate.resolve(); await f.close() }
})

await check('空闲结果立即存档，跨轮可见，恢复和重新挂载按报告 ID 去重', async () => {
  let parentRounds = 0
  const requests: ChatMessage[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages.findLast((message) => message.role === 'user')?.content === 'child') yield { type: 'text', text: marker }
    else {
      requests.push(structuredClone(messages))
      if (++parentRounds === 1) yield { type: 'tool_call', id: 'parent-read', name: 'read_file', arguments: {} }
      else yield { type: 'text', text: 'PARENT-DONE' }
    }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  try {
    const record = await f.finished(await f.child('child'))
    assert.equal(reports(f.store.recoverById(f.memory.sessionId)!.messages).length, 1)
    await bounded(f.chat.send('parent'))
    assert.equal(requests.length, 2)
    assert(requests.every((messages) => reports(messages).filter((message) => message.content.includes(marker)).length === 1))
    f.chat.resume(f.memory.sessionId)
    await tick()
    assert.equal(reports(f.history.view()).length, 1)
    await f.remount()
    assert.equal(reports(f.history.view()).length, 1)
    assert.equal(f.chat.messages.length, 0)
    const relay = new SubAgentResults()
    assert.equal(relay.receive(record, f.memory.sessionId, f.history), null)
    assert.equal(relay.take().length, 0)
  } finally { await f.close() }
})

await check('工具执行期间结果只排队，完整工具消息后写入，下一轮仍可见且 usage 不重复计算', async () => {
  const toolStarted = deferred()
  const gate = deferred()
  let rounds = 0
  const requests: ChatMessage[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages.findLast((message) => message.role === 'user')?.content === 'child') yield { type: 'text', text: marker }
    else {
      requests.push(structuredClone(messages))
      yield { type: 'usage', inputTokens: 4000, outputTokens: 2 }
      if (++rounds < 3) yield { type: 'tool_call', id: `parent-read-${rounds}`, name: 'read_file', arguments: { round: rounds } }
      else yield { type: 'text', text: 'PARENT-DONE' }
    }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  const read = f.registry.get('read_file')!
  const execute = read.execute
  read.execute = async (args, ctx) => {
    if (args.round === 1) { toolStarted.resolve(); await resolveOnAbort(gate.promise, ctx.signal, undefined) }
    return execute(args, ctx)
  }
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('parent')
    await bounded(toolStarted.promise)
    const record = await f.finished(await f.child('child'))
    assert.equal(record.status, 'done')
    assert.equal(reports(f.history.view()).length, 0)
    assert.equal(f.store.hasReportReceipt(f.memory.sessionId, record.reportId!), false)
    gate.resolve()
    await bounded(pending)
    assert.equal(requests.length, 3)
    assert.equal(reports(requests[0]).length, 0)
    assert.equal(reports(requests[1]).length, 1)
    assert.equal(reports(requests[2]).length, 1)
    assert.equal(reports(f.history.view()).length, 1)
    assert.equal(f.store.hasReportReceipt(f.memory.sessionId, record.reportId!), true)
    assert.deepEqual(sanitizeMessages(f.history.view()), f.history.view())
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
    assert.equal(f.chat.getToolContext().contextBudget!().lastInputTokens, 4000)
  } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
})

await check('主发送在 message Hook 收尾等待时收到的结果也在本次结束前存档', async () => {
  const started = deferred()
  const gate = deferred()
  const hooks = new HookEngine([])
  hooks.fire = async (event, _context, signal) => {
    if (event === 'message') { started.resolve(); await resolveOnAbort(gate.promise, signal, undefined) }
  }
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    yield { type: 'text', text: messages.findLast((message) => message.role === 'user')?.content === 'child' ? marker : 'PARENT-DONE' }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider, { hooks })
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('parent')
    await bounded(started.promise)
    await f.finished(await f.child('child'))
    gate.resolve()
    await bounded(pending)
    assert.equal(reports(f.history.view()).length, 1)
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
})

await check('空闲结果写入冲突保存副本并切换，保留原会话外部内容', async () => {
  const gate = deferred()
  const started = deferred()
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined)
    yield { type: 'text', text: marker }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  try {
    f.history.push({ role: 'user', content: 'LOCAL-ORIGINAL' })
    f.store.replace(f.memory.sessionId, f.history.all())
    const previous = f.memory.sessionId
    const id = await f.child('child')
    await bounded(started.promise)
    const external = new SessionStore(f.root + '/sessions')
    external.append(previous, [{ role: 'assistant', content: 'EXTERNAL-WRITE' }])
    gate.resolve()
    await f.finished(id)
    assert.notEqual(f.memory.sessionId, previous)
    assert.equal(external.recoverById(previous)!.messages.at(-1)!.content, 'EXTERNAL-WRITE')
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
    assert.equal(reports(f.history.view()).length, 1)
  } finally { gate.resolve(); await f.close() }
})

await check('主发送取消后仍保存已回流的子任务结果，工具消息保持完整', async () => {
  const started = deferred()
  const gate = deferred()
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages.findLast((message) => message.role === 'user')?.content === 'child') yield { type: 'text', text: marker }
    else yield { type: 'tool_call', id: 'cancel-read', name: 'read_file', arguments: {} }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  f.registry.get('read_file')!.execute = async (_args, ctx) => {
    started.resolve(); await resolveOnAbort(gate.promise, ctx.signal, undefined)
    return { success: true, output: 'READ' }
  }
  let running: Promise<void> | undefined
  try {
    running = f.chat.send('parent')
    await bounded(started.promise)
    await f.finished(await f.child('child'))
    assert.equal(reports(f.history.view()).length, 0)
    f.chat.cancel()
    await bounded(running)
    assert.equal(reports(f.history.view()).length, 1)
    assert.deepEqual(sanitizeMessages(f.history.view()), f.history.view())
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { gate.resolve(); await running; await f.close() }
})

await check('切换会话后旧子任务结果不污染新会话，恢复原会话只回流一次', async () => {
  const gate = deferred()
  const started = deferred()
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined)
    yield { type: 'text', text: marker }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  try {
    const original = f.memory.sessionId
    f.store.replace(original, [{ role: 'user', content: 'ORIGINAL-SESSION' }])
    const id = await f.child('child')
    await bounded(started.promise)
    f.chat.newSession()
    await tick()
    gate.resolve()
    await f.finished(id, original)
    assert.equal(f.history.length, 0)
    assert(!f.chat.messages.some((message) => message.text.includes(marker)))
    f.chat.resume(original)
    await tick(); await tick()
    assert.equal(reports(f.history.view()).length, 1, `首次恢复未回流: ${JSON.stringify({ session: f.chat.getToolContext().sessionId, records: f.manager.listRecords(original), messages: f.chat.messages })}`)
    assert.deepEqual(f.store.recoverById(original)?.messages, f.history.view())
    f.chat.resume(original)
    await tick(); await tick()
    assert.equal(reports(f.history.view()).length, 1, '再次恢复不能丢失或重复报告')
  } finally { gate.resolve(); await f.close() }
})

await check('清空后新回流完整保存当前历史，不复活旧消息和已经通知的报告', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    yield { type: 'text', text: `RESULT-${messages.findLast((message) => message.role === 'user')?.content}` }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  try {
    f.history.push({ role: 'user', content: 'OLD-HISTORY' })
    await f.finished(await f.child('old'))
    f.chat.clearHistory()
    await tick()
    await f.finished(await f.child('new'))
    assert.equal(reports(f.history.view()).length, 1)
    assert(f.history.view()[0].content.includes('RESULT-new'))
    assert(!JSON.stringify(f.history.view()).includes('RESULT-old'))
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
    assert(!JSON.stringify(f.history.view()).includes('OLD-HISTORY'))
  } finally { await f.close() }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
