import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SessionStore } from '../src/memory/index.ts'
import { SUMMARY_SYSTEM } from '../src/context/summary.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0
let failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name + ': ' + String(error)) }
}
const fresh = (f: Awaited<ReturnType<typeof streamFixture>>) => new SessionStore(join(f.root, 'sessions'))
const reports = (messages: readonly ChatMessage[]) => messages.filter((message) => message.role === 'system' && message.content.startsWith('[子任务报告 '))
const provider: Provider = { protocol: 'openai', async *streamChat() {
  yield { type: 'text', text: 'MAIN-ANSWER' }; yield { type: 'done' }
} }

for (const action of ['new', 'resume-current', 'resume-other']) for (const restored of [false, true]) {
  await check(action + ' 在保存失败时保留当前会话，存储恢复后先保存再切换 ' + restored, async () => {
    const transitions: string[] = []
    const f = await streamFixture(provider, { onSessionChange: (id) => { transitions.push(id) } })
    const append = f.store.append.bind(f.store), replace = f.store.replace.bind(f.store)
    try {
      await bounded(f.chat.send('SAVED-USER'))
      const original = f.memory.sessionId
      fresh(f).replace('target-session', [{ role: 'user', content: 'TARGET-USER' }])
      f.store.append = f.store.replace = () => { throw new Error('MAIN-SAVE-ERROR') }
      await bounded(f.chat.send('UNSAVED-USER'))
      const before = structuredClone(f.history.all())
      const budget = f.chat.getToolContext().contextBudget!()
      assert(before.some((message) => message.content === 'UNSAVED-USER'))
      const invoke = () => action === 'new' ? f.chat.newSession() : f.chat.resume(action === 'resume-current' ? original : 'target-session')
      if (!restored) {
        assert.match(invoke(), /保存失败/)
        assert.deepEqual(f.history.view(), before)
        assert.equal(f.memory.sessionId, original)
        assert.equal(f.chat.getToolContext().sessionId, original)
        assert.deepEqual(f.chat.getToolContext().contextBudget!(), budget)
        assert.deepEqual(transitions, [])
      }
      f.store.append = append; f.store.replace = replace
      assert.match(invoke(), /已新建会话|已恢复会话/)
      assert(fresh(f).recoverById(original)!.messages.some((message) => message.content === 'UNSAVED-USER'))
      if (action === 'resume-current') assert.deepEqual(f.history.view(), before)
      else assert.match(f.chat.resume(original), /已恢复会话/)
      assert(f.history.view().some((message) => message.content === 'UNSAVED-USER'))
    } finally { f.store.append = append; f.store.replace = replace; await f.close() }
  })
}

await check('恢复不存在的会话不写盘、不切换或丢掉未保存历史', async () => {
  const f = await streamFixture(provider)
  const append = f.store.append.bind(f.store), replace = f.store.replace.bind(f.store)
  try {
    await bounded(f.chat.send('SAVED-USER'))
    f.store.append = f.store.replace = () => { throw new Error('MAIN-SAVE-ERROR') }
    await bounded(f.chat.send('UNSAVED-USER'))
    let writes = 0
    f.store.append = f.store.replace = () => { writes++; throw new Error('UNEXPECTED-WRITE') }
    const before = structuredClone(f.history.all())
    assert.equal(f.chat.resume('missing-session'), '未找到会话: missing-session')
    assert.equal(writes, 0)
    assert.deepEqual(f.history.view(), before)
  } finally { f.store.append = append; f.store.replace = replace; await f.close() }
})

for (const action of ['new', 'resume-other']) await check('切换前保存遇到外部更新，保留两份内容并返回副本 ID ' + action, async () => {
  const f = await streamFixture(provider)
  const append = f.store.append.bind(f.store), replace = f.store.replace.bind(f.store)
  try {
    await bounded(f.chat.send('SAVED-USER'))
    const original = f.memory.sessionId
    fresh(f).replace('target-session', [{ role: 'user', content: 'TARGET-USER' }])
    f.store.append = f.store.replace = () => { throw new Error('MAIN-SAVE-ERROR') }
    await bounded(f.chat.send('UNSAVED-USER'))
    fresh(f).append(original, [{ role: 'user', content: 'EXTERNAL-WRITE' }])
    f.store.append = append; f.store.replace = replace
    const result = action === 'new' ? f.chat.newSession() : f.chat.resume('target-session')
    assert.match(result, /已新建会话|已恢复会话/)
    const copy = fresh(f).listSessions(20).find((session) => session.id.startsWith(original + '-conflict-'))!
    assert(copy)
    assert(result.includes(copy.id))
    assert.equal(fresh(f).recoverById(original)?.messages.at(-1)?.content, 'EXTERNAL-WRITE')
    const saved = fresh(f).recoverById(copy.id)!.messages
    assert(saved.some((message) => message.content === 'UNSAVED-USER'))
    assert(!saved.some((message) => message.content === 'EXTERNAL-WRITE'))
    assert.match(f.chat.resume(copy.id), /已恢复会话/)
    assert.deepEqual(f.history.view(), saved)
  } finally { f.store.append = append; f.store.replace = replace; await f.close() }
})

for (const mode of ['once', 'twice', 'new-session']) await check('冲突副本保留具体子任务关联，迟到结果正确回流且隔离其他任务 ' + mode, async () => {
  const gates = new Map(['child-a', 'child-b', 'child-c', 'foreign-child'].map((name) => [name, { started: deferred(), done: deferred() }]))
  const requests: ChatMessage[][] = []
  const capture: Provider = { protocol: 'openai', async *streamChat(messages) {
    const user = messages.findLast((message) => message.role === 'user')?.content ?? ''
    const gate = gates.get(user)
    if (gate) { gate.started.resolve(); await gate.done.promise; yield { type: 'text', text: user.toUpperCase() + '-RESULT' } }
    else { requests.push(structuredClone(messages)); yield { type: 'text', text: 'PARENT-ANSWER' } }
    yield { type: 'done' }
  } }
  const f = await streamFixture(capture)
  try {
    await bounded(f.chat.send('PARENT-START'))
    const original = f.memory.sessionId
    const a = await f.child('child-a'), b = await f.child('child-b')
    const c = mode === 'twice' ? await f.child('child-c') : undefined
    const foreign = await f.manager.spawn({ type: 'defined', role: 'probe', prompt: 'foreign-child', async: true }, {
      provider: capture, registry: f.registry, ctx: { ...f.chat.getToolContext(), agentId: 'foreign-parent' },
    })
    await bounded(Promise.all(['child-a', 'child-b', 'foreign-child', ...(c ? ['child-c'] : [])].map((name) => gates.get(name)!.started.promise)))
    fresh(f).append(original, [{ role: 'user', content: 'EXTERNAL-WRITE' }])
    gates.get('child-a')!.done.resolve()
    await f.finished(a, original)
    let copy = f.memory.sessionId
    assert.notEqual(copy, original)
    const sources = fresh(f).getSubAgentTaskSources(copy)
    assert(sources.some((source) => source.sessionId === original && source.agentId === b))
    assert(!sources.some((source) => source.agentId === foreign.id))
    if (c) {
      fresh(f).append(copy, [{ role: 'user', content: 'EXTERNAL-COPY-WRITE' }])
      gates.get('child-c')!.done.resolve()
      await f.finished(c, original)
      assert.notEqual(f.memory.sessionId, copy)
      copy = f.memory.sessionId
      assert(fresh(f).getSubAgentTaskSources(copy).some((source) => source.sessionId === original && source.agentId === b))
    }
    f.memory.sessionStore = fresh(f)
    f.memory.sessionStore.recoverById(copy)
    await f.remount()
    if (mode === 'new-session') {
      assert.equal(f.chat.newSession(), '已新建会话')
      await tick(); await tick()
    }
    gates.get('child-b')!.done.resolve()
    const result = await f.finished(b, original)
    if (mode === 'new-session') {
      assert(!JSON.stringify(f.history.view()).includes('CHILD-B-RESULT'))
      assert.match(f.chat.resume(copy), /已恢复会话/)
      await tick(); await tick()
    }
    assert.equal(reports(f.history.view()).filter((message) => message.content.includes('CHILD-B-RESULT')).length, 1)
    assert(fresh(f).hasReportReceipt(copy, result.reportId!))
    gates.get('foreign-child')!.done.resolve()
    await f.finished(foreign.id, original)
    assert(!JSON.stringify(f.history.view()).includes('FOREIGN-CHILD-RESULT'))
    await bounded(f.chat.send('PARENT-FOLLOW-UP'))
    assert.equal(reports(requests.at(-1)!).filter((message) => message.content.includes('CHILD-B-RESULT')).length, 1)
    assert(!JSON.stringify(requests.at(-1)).includes('FOREIGN-CHILD-RESULT'))
    assert.equal(f.memory.sessionId, copy)
    assert.deepEqual(fresh(f).recoverById(copy)?.messages, f.history.view())
    await f.remount()
    assert.equal(reports(f.history.view()).filter((message) => message.content.includes('CHILD-B-RESULT')).length, 1)
    assert.equal(f.chat.messages.length, 0)
    assert.equal(fresh(f).listSessions(20).find((session) => session.id === copy)?.count, f.history.length)
  } finally { for (const gate of gates.values()) gate.done.resolve(); await f.close() }
})

for (const mode of ['success', 'retry', 'conflict']) await check('未保存报告被摘要后，回流收据随摘要保存且恢复不重复 ' + mode, async () => {
  const capture: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages[0]?.content === SUMMARY_SYSTEM) {
      assert(JSON.stringify(messages).includes('UNSAVED-COMPACT-RESULT'))
      yield { type: 'text', text: '摘要：UNSAVED-COMPACT-RESULT 已完成，继续后续任务。' }
    } else yield { type: 'text', text: messages.findLast((message) => message.role === 'user')?.content === 'unsaved-child' ? 'UNSAVED-COMPACT-RESULT' : 'PARENT-ANSWER' }
    yield { type: 'done' }
  } }
  const f = await streamFixture(capture)
  const append = f.store.append.bind(f.store), replace = f.store.replace.bind(f.store)
  try {
    for (let i = 0; i < 40; i++) f.history.push({ role: i % 2 ? 'assistant' : 'user', content: 'BASE-' + i + '\n' + 'x'.repeat(10000) })
    replace(f.memory.sessionId, f.history.all())
    assert.match(f.chat.resume(f.memory.sessionId), /已恢复会话/)
    const original = f.memory.sessionId
    f.store.append = f.store.replace = () => { throw new Error('COMPACT-REPORT-SAVE-ERROR') }
    const child = await f.finished(await f.child('unsaved-child'))
    assert.equal(fresh(f).hasReportReceipt(original, child.reportId!), false)
    for (let i = 1; i <= 6; i++) await bounded(f.chat.send('follow-up-' + i + (i === 6 ? '\n' + 'x'.repeat(300000) : '')))
    if (mode !== 'retry') { f.store.append = append; f.store.replace = replace }
    if (mode === 'conflict') fresh(f).append(original, [{ role: 'user', content: 'EXTERNAL-WRITE' }])
    const compacted = await bounded(f.chat.compact())
    assert.match(compacted, mode === 'retry' ? /保存失败/ : /压缩完成/)
    assert.equal(reports(f.history.view()).length, 0)
    assert(f.history.view()[0].content.includes('UNSAVED-COMPACT-RESULT'))
    if (mode === 'retry') {
      assert.equal(fresh(f).hasReportReceipt(original, child.reportId!), false)
      assert.match(f.chat.resume(original), /保存失败/)
      f.store.append = append; f.store.replace = replace
      await bounded(f.chat.send('RETRY-SAVE'))
    }
    const saved = f.memory.sessionId
    if (mode === 'conflict') {
      assert.notEqual(saved, original)
      assert.equal(fresh(f).recoverById(original)?.messages.at(-1)?.content, 'EXTERNAL-WRITE')
    }
    assert(fresh(f).hasReportReceipt(saved, child.reportId!))
    assert.match(f.chat.resume(saved), /已恢复会话/)
    await f.remount()
    assert.equal(reports(f.history.view()).length, 0)
    assert(f.history.view()[0].content.includes('UNSAVED-COMPACT-RESULT'))
    assert.equal(f.chat.messages.length, 0)
    assert.deepEqual(fresh(f).recoverById(saved)?.messages, f.history.view())
  } finally { f.store.append = append; f.store.replace = replace; await f.close() }
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exitCode = failed > 0 ? 1 : 0
