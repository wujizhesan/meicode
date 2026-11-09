import assert from 'node:assert/strict'
import { join } from 'node:path'
import { sanitizeMessages, SessionStore } from '../src/memory/index.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { SubAgentManager, SubAgentStore } from '../src/subagent/index.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0
let failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
type Fixture = Awaited<ReturnType<typeof streamFixture>>
const reports = (messages: readonly ChatMessage[]) => messages.filter((message) => message.role === 'system' && message.content.startsWith('[子任务报告 '))
function external(f: Fixture) {
  const manager = new SubAgentManager({ builtin: join(f.root, 'none'), user: join(f.root, 'none'), project: join(f.root, 'roles') },
    null, new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId))
  manager.loadRoles()
  return manager
}
const spawn = (f: Fixture, manager: SubAgentManager, provider: Provider, prompt = 'external-child') => manager.spawn(
  { type: 'defined', role: 'probe', prompt, async: true }, { provider, registry: f.registry, ctx: f.chat.getToolContext() },
)
async function waitUntil(condition: () => boolean) {
  const deadline = performance.now() + 6500
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('未在周期检查后同步外部结果')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

for (const status of ['done', 'error']) await check('发送前同步另一管理器的 ' + status + ' 报告，多次发送和重新挂载不重复', async () => {
  const requests: ChatMessage[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    const child = messages.findLast((message) => message.role === 'user')?.content === 'external-child'
    if (child && status === 'error') yield { type: 'error', message: 'EXTERNAL-FAILED' }
    else {
      if (!child) requests.push(structuredClone(messages))
      yield { type: 'text', text: child ? 'EXTERNAL-DONE' : 'PARENT-DONE' }
    }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider), other = external(f)
  try {
    await bounded(f.chat.send('PARENT-START'))
    const submitted = await spawn(f, other, provider)
    assert(!submitted.error)
    const record = (await bounded(other.waitFor(submitted.id, 2000, f.memory.sessionId))).record!
    assert.equal(record.status, status)
    assert.equal(reports(f.history.view()).length, 0)
    await bounded(f.chat.send('PARENT-FOLLOW-UP'))
    const detail = status === 'done' ? 'EXTERNAL-DONE' : 'EXTERNAL-FAILED'
    assert.equal(reports(requests.at(-1)!).filter((message) => message.content.includes(detail)).length, 1)
    assert.equal(reports(f.history.view()).length, 1)
    assert(f.store.hasReportReceipt(f.memory.sessionId, record.reportId!))
    await bounded(f.chat.send('PARENT-SECOND-FOLLOW-UP'))
    assert.equal(reports(requests.at(-1)!).length, 1)
    await tick(); await tick()
    assert.equal(f.chat.messages.filter((message) => message.role === 'tool' && message.text.includes(detail)).length, 1)
    await f.remount()
    assert.equal(f.chat.messages.length, 0)
    await bounded(f.chat.send('PARENT-AFTER-REMOUNT'))
    assert.equal(reports(requests.at(-1)!).length, 1)
    assert.deepEqual(new SessionStore(join(f.root, 'sessions')).recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await other.close(1000); await f.close() }
})

await check('空闲周期检查自动回流外部报告并立即存档', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    yield { type: 'text', text: 'EXTERNAL-PERIODIC-DONE' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider), other = external(f)
  try {
    const submitted = await spawn(f, other, provider)
    const record = (await bounded(other.waitFor(submitted.id, 2000, f.memory.sessionId))).record!
    assert.equal(record.status, 'done')
    assert.equal(reports(f.history.view()).length, 0)
    await waitUntil(() => reports(f.history.view()).length === 1)
    await tick(); await tick()
    assert(f.store.hasReportReceipt(f.memory.sessionId, record.reportId!))
    assert.equal(f.chat.messages.filter((message) => message.text.includes('EXTERNAL-PERIODIC-DONE')).length, 1)
    assert.deepEqual(new SessionStore(join(f.root, 'sessions')).recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await other.close(1000); await f.close() }
})

await check('周期检查在主工具执行期间只排队，下一轮带入结果且工具消息完整', async () => {
  const requests: ChatMessage[][] = []
  const started = deferred(), gate = deferred()
  let rounds = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages.findLast((message) => message.role === 'user')?.content === 'external-child') yield { type: 'text', text: 'EXTERNAL-TOOL-RESULT' }
    else {
      requests.push(structuredClone(messages))
      yield { type: 'usage', inputTokens: 4000, outputTokens: 1 }
      if (++rounds === 1) yield { type: 'tool_call', id: 'parent-read', name: 'read_file', arguments: {} }
      else yield { type: 'text', text: 'PARENT-DONE' }
    }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider), other = external(f)
  f.registry.get('read_file')!.execute = async () => { started.resolve(); await gate.promise; return { success: true, output: 'READ-DONE' } }
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('PARENT-WITH-TOOL')
    await bounded(started.promise)
    const submitted = await spawn(f, other, provider)
    const record = (await bounded(other.waitFor(submitted.id, 2000, f.memory.sessionId))).record!
    assert.equal(record.status, 'done')
    await waitUntil(() => f.chat.messages.some((message) => message.text.includes('EXTERNAL-TOOL-RESULT')))
    assert.equal(reports(f.history.view()).length, 0)
    assert.equal(f.store.hasReportReceipt(f.memory.sessionId, record.reportId!), false)
    gate.resolve()
    await bounded(pending)
    assert.equal(requests.length, 2)
    assert.equal(reports(requests[0]).length, 0)
    assert.equal(reports(requests[1]).length, 1)
    assert.equal(reports(f.history.view()).length, 1)
    assert.deepEqual(sanitizeMessages(f.history.view()), f.history.view())
    assert(f.store.hasReportReceipt(f.memory.sessionId, record.reportId!))
    assert.equal(f.chat.getToolContext().contextBudget!().lastInputTokens, 4000)
  } finally { gate.resolve(); if (pending) await bounded(pending); await other.close(1000); await f.close() }
})

await check('切换新会话后不串入旧会话的外部报告，恢复原会话才回流', async () => {
  const started = deferred(), gate = deferred(), requests: ChatMessage[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages.findLast((message) => message.role === 'user')?.content === 'external-child') {
      started.resolve(); await gate.promise; yield { type: 'text', text: 'EXTERNAL-OLD-SESSION' }
    } else { requests.push(structuredClone(messages)); yield { type: 'text', text: 'PARENT-DONE' } }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider), other = external(f)
  try {
    await bounded(f.chat.send('PARENT-START'))
    const original = f.memory.sessionId
    const submitted = await spawn(f, other, provider)
    await bounded(started.promise)
    assert.equal(f.chat.newSession(), '已新建会话')
    gate.resolve()
    assert.equal((await bounded(other.waitFor(submitted.id, 2000, original))).record?.status, 'done')
    await bounded(f.chat.send('PARENT-NEW-SESSION'))
    assert(!JSON.stringify(requests.at(-1)).includes('EXTERNAL-OLD-SESSION'))
    assert.equal(reports(f.history.view()).length, 0)
    assert.match(f.chat.resume(original), /已恢复会话/)
    await tick(); await tick()
    assert.equal(reports(f.history.view()).length, 1)
  } finally { gate.resolve(); await other.close(1000); await f.close() }
})

await check('副本发送前只同步明确关联的外部任务，排除同来源会话其他任务', async () => {
  const started = deferred(), gate = deferred(), requests: ChatMessage[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    const user = messages.findLast((message) => message.role === 'user')?.content ?? ''
    if (user.startsWith('external-')) { started.resolve(); await gate.promise; yield { type: 'text', text: user === 'external-child' ? 'EXTERNAL-LINKED' : 'EXTERNAL-UNLINKED' } }
    else { requests.push(structuredClone(messages)); yield { type: 'text', text: 'PARENT-DONE' } }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider), other = external(f)
  try {
    await bounded(f.chat.send('PARENT-START'))
    const original = f.memory.sessionId
    const linked = await spawn(f, other, provider), unlinked = await spawn(f, other, provider, 'external-unlinked')
    await bounded(started.promise)
    new SessionStore(join(f.root, 'sessions')).replace('linked-copy', f.history.all(), [], [{ sessionId: original, agentId: linked.id }])
    assert.match(f.chat.resume('linked-copy'), /已恢复会话/)
    gate.resolve()
    const completed = await bounded(Promise.all([linked, unlinked].map((task) => other.waitFor(task.id, 2000, original))))
    assert(completed.every((result) => result.record?.status === 'done'))
    assert.equal(reports(f.history.view()).length, 0)
    await bounded(f.chat.send('PARENT-COPY-FOLLOW-UP'))
    assert.equal(reports(requests.at(-1)!).length, 1)
    assert(JSON.stringify(requests.at(-1)).includes('EXTERNAL-LINKED'))
    assert(!JSON.stringify(requests.at(-1)).includes('EXTERNAL-UNLINKED'))
    assert(f.store.hasReportReceipt('linked-copy', completed[0].record!.reportId!))
    assert.equal(f.store.hasReportReceipt('linked-copy', completed[1].record!.reportId!), false)
  } finally { gate.resolve(); await other.close(1000); await f.close() }
})

console.log('subagent_external_sync_test: ' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
