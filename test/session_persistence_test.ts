import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SUMMARY_SYSTEM } from '../src/context/summary.ts'
import { SessionConflictError, SessionStore } from '../src/memory/index.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { SubAgentResults } from '../src/tui/subagent-results.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0
let failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${String(error)}`) }
}
const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
  yield { type: 'text', text: messages[0]?.content === SUMMARY_SYSTEM ? '摘要：子任务 CHILD-RESULT 已完成，继续当前任务。' : 'CHILD-RESULT' }
  yield { type: 'done' }
} }
const largeHistory = (f: Awaited<ReturnType<typeof streamFixture>>) => {
  for (let i = 0; i < 40; i++) f.history.push({ role: i % 2 ? 'assistant' : 'user', content: `LONG-${i}\n${'x'.repeat(18000)}` })
}
const reports = (messages: readonly ChatMessage[]) => messages.filter((message) => message.role === 'system' && message.content.startsWith('[子任务报告 '))
const freshStore = (f: Awaited<ReturnType<typeof streamFixture>>) => new SessionStore(join(f.root, 'sessions'))

for (const tail of ['complete', 'partial', 'receipt', 'empty']) await check(`追加隔离 ${tail} 尾行，保留完整消息和新报告`, async () => {
  const f = await streamFixture(provider)
  try {
    const id = 'tail-session'
    f.store.replace(id, [])
    const base: ChatMessage = { role: 'user', content: 'BASE-中文' }
    const existing = tail === 'complete' ? JSON.stringify(base)
      : tail === 'partial' ? `${JSON.stringify(base)}\n{"role":"assistant","content":"BROKEN`
        : tail === 'receipt' ? `${JSON.stringify(base)}\n${JSON.stringify({ type: 'subagent_report_receipts', ids: ['old-report'] })}` : ''
    const file = join(f.root, 'sessions', `${id}.jsonl`)
    writeFileSync(file, existing)
    const store = freshStore(f)
    assert.equal(store.recoverById(id)?.messages.length, tail === 'empty' ? 0 : 1)
    const added: ChatMessage[] = [
      { role: 'assistant', content: 'NEW-MESSAGE' },
      { role: 'system', content: '[子任务报告 new-report]\nNEW-RESULT' },
    ]
    store.append(id, added)
    const expected = tail === 'empty' ? added : [base, ...added]
    assert.deepEqual(freshStore(f).recoverById(id)?.messages, expected)
    assert(readFileSync(file, 'utf8').startsWith(existing))
    assert(freshStore(f).hasReportReceipt(id, 'new-report'))
    if (tail === 'receipt') assert(freshStore(f).hasReportReceipt(id, 'old-report'))
    assert.equal(store.listSessions(10).find((session) => session.id === id)?.count, expected.length)
    store.append(id, [{ role: 'user', content: 'NEXT-MESSAGE' }])
    assert.equal(freshStore(f).recoverById(id)?.messages.length, expected.length + 1)
  } finally { await f.close() }
})

await check('恢复回调失败保留旧写入基线，清空创建副本而不覆盖外部消息', async () => {
  let rejectSwitch = false
  const f = await streamFixture(provider, { onSessionChange: () => {
    if (rejectSwitch) throw new Error('SESSION-SWITCH-ERROR')
  } })
  try {
    await bounded(f.chat.send('LOCAL-USER'))
    const original = f.memory.sessionId
    const before = structuredClone(f.history.all())
    freshStore(f).append(original, [{ role: 'user', content: 'EXTERNAL-MUST-SURVIVE' }])
    rejectSwitch = true
    assert.match(f.chat.resume(original), /SESSION-SWITCH-ERROR/)
    assert.equal(f.memory.sessionId, original)
    assert.deepEqual(f.history.view(), before)
    rejectSwitch = false
    f.chat.clearHistory()
    assert.notEqual(f.memory.sessionId, original)
    assert.deepEqual(freshStore(f).recoverById(original)?.messages, [...before, { role: 'user', content: 'EXTERNAL-MUST-SURVIVE' }])
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, [])
  } finally { rejectSwitch = false; await f.close() }
})

await check('恢复失败不继承外部报告收据到本地冲突副本，成功恢复后可继续追加', async () => {
  let rejectSwitch = false
  const f = await streamFixture(provider, { onSessionChange: () => {
    if (rejectSwitch) throw new Error('SESSION-SWITCH-ERROR')
  } })
  try {
    const child = await f.finished(await f.child('local-child'))
    const original = f.memory.sessionId
    freshStore(f).append(original, [{ role: 'system', content: '[子任务报告 external-report]\nEXTERNAL-RESULT' }])
    rejectSwitch = true
    assert.match(f.chat.resume(original), /SESSION-SWITCH-ERROR/)
    const copy = f.store.saveConflictCopy(original, f.history.all())
    assert(freshStore(f).hasReportReceipt(copy, child.reportId!))
    assert.equal(freshStore(f).hasReportReceipt(copy, 'external-report'), false)
    rejectSwitch = false
    assert.match(f.chat.resume(original), /已恢复会话/)
    await bounded(f.chat.send('AFTER-RECOVERY'))
    assert.equal(f.memory.sessionId, original)
    assert.deepEqual(freshStore(f).recoverById(original)?.messages, f.history.view())
  } finally { rejectSwitch = false; await f.close() }
})

await check('恢复读取后出现外部写入，确认读取快照仍保留冲突保护', async () => {
  const f = await streamFixture(provider)
  try {
    await bounded(f.chat.send('LOCAL-USER'))
    const id = f.memory.sessionId
    const recovery = f.store.prepareRecovery(id)!
    const before = structuredClone(recovery.messages)
    freshStore(f).append(id, [{ role: 'user', content: 'EXTERNAL-AFTER-READ' }])
    recovery.commit()
    assert.deepEqual(recovery.messages, before)
    assert.throws(() => f.store.replace(id, before), SessionConflictError)
    assert.equal(freshStore(f).recoverById(id)?.messages.at(-1)?.content, 'EXTERNAL-AFTER-READ')
  } finally { await f.close() }
})

for (const switchAway of [false, true]) await check(`报告保存失败后${switchAway ? '切换前保存再恢复' : '保留现场并重试恢复'}，只落盘一次`, async () => {
  const requests: ChatMessage[][] = []
  const capture: Provider = { protocol: 'openai', async *streamChat(messages) {
    const child = messages.findLast((message) => message.role === 'user')?.content === 'unsaved-child'
    if (!child) requests.push(structuredClone(messages))
    yield { type: 'text', text: child ? 'UNSAVED-CHILD-RESULT' : 'PARENT-DONE' }
    yield { type: 'done' }
  } }
  const f = await streamFixture(capture)
  const append = f.store.append.bind(f.store), replace = f.store.replace.bind(f.store)
  try {
    await bounded(f.chat.send('PARENT-START'))
    const original = f.memory.sessionId
    f.store.append = f.store.replace = () => { throw new Error('REPORT-SAVE-ERROR') }
    const child = await f.finished(await f.child('unsaved-child'))
    assert(f.chat.messages.some((message) => message.text.includes('REPORT-SAVE-ERROR')))
    assert.equal(reports(f.history.view()).length, 1)
    assert.equal(reports(freshStore(f).recoverById(original)!.messages).length, 0)
    assert.equal(freshStore(f).hasReportReceipt(original, child.reportId!), false)
    if (switchAway) {
      f.store.append = append; f.store.replace = replace
      f.store.replace('other-session', [{ role: 'user', content: 'OTHER-SESSION' }])
      assert.match(f.chat.resume('other-session'), /已恢复会话/)
      assert.equal(reports(f.history.view()).length, 0)
      assert(freshStore(f).hasReportReceipt(original, child.reportId!))
      f.store.append = f.store.replace = () => { throw new Error('REPORT-SAVE-ERROR') }
    } else {
      assert.match(f.chat.resume(original), /保存失败/)
      assert.equal(reports(f.history.view()).length, 1)
      assert.equal(freshStore(f).hasReportReceipt(original, child.reportId!), false)
      f.store.append = append; f.store.replace = replace
    }
    assert.match(f.chat.resume(original), /已恢复会话/)
    assert.equal(reports(f.history.view()).length, 1)
    assert(freshStore(f).hasReportReceipt(original, child.reportId!))
    assert.match(f.chat.resume(original), /已恢复会话/)
    assert.equal(reports(f.history.view()).length, 1)
    f.store.append = append; f.store.replace = replace
    await bounded(f.chat.send('PARENT-FOLLOW-UP'))
    assert.equal(reports(requests.at(-1)!).filter((message) => message.content.includes('UNSAVED-CHILD-RESULT')).length, 1)
    assert(freshStore(f).hasReportReceipt(original, child.reportId!))
    assert.deepEqual(freshStore(f).recoverById(original)?.messages, f.history.view())
    assert.match(f.chat.resume(original), /已恢复会话/)
    await f.remount()
    assert.equal(reports(f.history.view()).length, 1)
    assert.equal(f.chat.messages.length, 0)
  } finally { f.store.append = append; f.store.replace = replace; await f.close() }
})

await check('清空后立即保存空历史，随后发送和恢复不带回旧消息', async () => {
  const f = await streamFixture(provider)
  try {
    await bounded(f.chat.send('OLD-USER'))
    f.chat.clearHistory()
    assert.equal(f.history.length, 0)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, [])
    await tick()
    await bounded(f.chat.send('NEW-USER'))
    assert.equal(f.history.length, 2)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
    f.chat.resume(f.memory.sessionId)
    assert.equal(f.history.length, 2)
    assert.equal(f.history.view()[0].content, 'NEW-USER')
  } finally { await f.close() }
})

await check('清空存档失败后显示错误，下一次发送重试完整历史', async () => {
  const f = await streamFixture(provider)
  const replace = f.store.replace.bind(f.store)
  try {
    await bounded(f.chat.send('OLD-USER'))
    f.store.replace = () => { throw new Error('CLEAR-SAVE-ERROR') }
    f.chat.clearHistory()
    await tick(); await tick()
    assert(f.chat.messages.some((message) => message.text.includes('CLEAR-SAVE-ERROR')))
    assert.equal(freshStore(f).recoverById(f.memory.sessionId)?.messages.length, 2)
    f.store.replace = replace
    await bounded(f.chat.send('NEW-USER'))
    assert.equal(f.history.length, 2)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { f.store.replace = replace; await f.close() }
})

await check('清空遇到外部更新时保存空副本，保留原存档和回流记录', async () => {
  const f = await streamFixture(provider)
  try {
    const child = await f.finished(await f.child('child'))
    const original = f.memory.sessionId
    freshStore(f).append(original, [{ role: 'user', content: 'EXTERNAL-WRITE' }])
    f.chat.clearHistory()
    assert.notEqual(f.memory.sessionId, original)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, [])
    assert.equal(freshStore(f).recoverById(original)?.messages.at(-1)?.content, 'EXTERNAL-WRITE')
    assert.equal(freshStore(f).hasReportReceipt(f.memory.sessionId, child.reportId!), true)
    await tick()
    await bounded(f.chat.send('COPY-USER'))
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

await check('手动压缩立即落盘，后续发送及恢复保留摘要', async () => {
  const f = await streamFixture(provider)
  try {
    largeHistory(f)
    f.store.replace(f.memory.sessionId, f.history.all())
    assert.equal(await bounded(f.chat.compact()), '压缩完成：早期对话已摘要')
    assert.equal(f.history.length, 7)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
    await bounded(f.chat.send('FOLLOW-UP'))
    assert.equal(f.history.length, 9)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
    f.chat.resume(f.memory.sessionId)
    assert.equal(f.history.length, 9)
    assert(f.history.view()[0].content.includes('早期对话摘要'))
  } finally { await f.close() }
})

await check('压缩存档失败不会误报保存成功，下次发送保留摘要并重试覆盖', async () => {
  const f = await streamFixture(provider)
  const replace = f.store.replace.bind(f.store)
  try {
    largeHistory(f)
    replace(f.memory.sessionId, f.history.all())
    f.store.replace = () => { throw new Error('COMPACT-SAVE-ERROR') }
    assert.match(await bounded(f.chat.compact()), /会话保存失败/)
    assert.equal(f.history.length, 7)
    assert.equal(freshStore(f).recoverById(f.memory.sessionId)?.messages.length, 40)
    f.store.replace = replace
    await bounded(f.chat.send('FOLLOW-UP'))
    assert.equal(f.history.length, 9)
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { f.store.replace = replace; await f.close() }
})

await check('压缩等待中外部追加会保存摘要副本并保留原会话更新', async () => {
  const started = deferred()
  const gate = deferred()
  const delayed: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (messages[0]?.content === SUMMARY_SYSTEM) { started.resolve(); await gate.promise }
    yield { type: 'text', text: 'COMPACT-SUMMARY' }; yield { type: 'done' }
  } }
  const f = await streamFixture(delayed)
  let pending: Promise<string> | undefined
  try {
    const child = await f.finished(await f.child('child'))
    largeHistory(f)
    const original = f.memory.sessionId
    f.store.replace(original, f.history.all())
    pending = f.chat.compact()
    await bounded(started.promise)
    freshStore(f).append(original, [{ role: 'assistant', content: 'EXTERNAL-WRITE' }])
    gate.resolve()
    assert.equal(await bounded(pending), '压缩完成：早期对话已摘要')
    assert.notEqual(f.memory.sessionId, original)
    assert.equal(freshStore(f).recoverById(original)?.messages.at(-1)?.content, 'EXTERNAL-WRITE')
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, child.reportId!))
  } finally { gate.resolve(); await pending; await f.close() }
})

await check('清空取消正在等待的手动压缩，迟到摘要不覆盖空存档', async () => {
  const started = deferred()
  const gate = deferred()
  const delayed: Provider = { protocol: 'openai', async *streamChat() {
    started.resolve(); await gate.promise
    yield { type: 'text', text: 'LATE-SUMMARY' }; yield { type: 'done' }
  } }
  const f = await streamFixture(delayed)
  let pending: Promise<string> | undefined
  try {
    largeHistory(f)
    f.store.replace(f.memory.sessionId, f.history.all())
    pending = f.chat.compact()
    await bounded(started.promise)
    f.chat.clearHistory()
    assert.match(await bounded(pending), /压缩已取消/)
    gate.resolve(); await tick(); await tick()
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, [])
    assert.equal(f.history.length, 0)
  } finally { gate.resolve(); await pending; await f.close() }
})

for (const mode of ['auto', 'manual']) await check(`${mode} 压缩后新存储实例恢复并挂载，不重复回流相同报告`, async () => {
  const f = await streamFixture(provider)
  try {
    const record = await f.finished(await f.child('child'))
    largeHistory(f)
    f.store.replace(f.memory.sessionId, f.history.all())
    if (mode === 'auto') await bounded(f.chat.send('AUTO-COMPACT'))
    else assert.match(await bounded(f.chat.compact()), /压缩完成/)
    assert.equal(reports(f.history.view()).length, 0)
    assert(f.history.view()[0].content.includes('CHILD-RESULT'))
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, record.reportId!))
    f.memory.sessionStore = freshStore(f)
    const recovered = f.memory.sessionStore.recoverById(f.memory.sessionId)!
    const length = recovered.messages.length
    f.history.clear()
    for (const message of recovered.messages) f.history.push(message)
    await f.remount()
    assert.equal(f.history.length, length)
    assert.equal(reports(f.history.view()).length, 0)
    assert.equal(f.chat.messages.length, 0)
  } finally { await f.close() }
})

await check('清空并重新挂载后旧报告不复活，新报告仍可保存', async () => {
  const f = await streamFixture(provider)
  try {
    const old = await f.finished(await f.child('old'))
    f.chat.clearHistory()
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, old.reportId!))
    await f.remount()
    assert.equal(f.history.length, 0)
    assert.equal(f.chat.messages.length, 0)
    const next = await f.finished(await f.child('next'))
    assert.equal(reports(f.history.view()).length, 1)
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, next.reportId!))
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

await check('旧版报告标记在清空或替换时迁移为独立回流记录', async () => {
  const f = await streamFixture(provider)
  try {
    const record = await f.finished(await f.child('legacy'))
    const file = join(f.root, 'sessions', `${f.memory.sessionId}.jsonl`)
    writeFileSync(file, f.history.view().map((message) => JSON.stringify(message)).join('\n') + '\n')
    const store = freshStore(f)
    assert(store.hasReportReceipt(f.memory.sessionId, record.reportId!))
    store.recoverById(f.memory.sessionId)
    store.replace(f.memory.sessionId, [])
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, record.reportId!))
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, [])
  } finally { await f.close() }
})

await check('回流元数据不进入模型历史或会话计数，普通内容不误记为报告', async () => {
  const f = await streamFixture(provider)
  try {
    const record = await f.finished(await f.child('child'))
    f.history.push({ role: 'user', content: '[子任务报告 user-fake]\n普通用户文本' })
    f.store.replace(f.memory.sessionId, f.history.all())
    const store = freshStore(f)
    assert.equal(store.listSessions(10).find((session) => session.id === f.memory.sessionId)?.count, 2)
    const messages = store.recoverById(f.memory.sessionId)!.messages
    assert.deepEqual(messages, f.history.view())
    assert.equal(store.hasReportReceipt(f.memory.sessionId, 'user-fake'), false)
    assert(store.hasReportReceipt(f.memory.sessionId, record.reportId!))
    assert.equal(new SubAgentResults().receive(record, f.memory.sessionId, f.history, store), null)
    store.replace('other-session', [])
    assert.equal(store.hasReportReceipt('other-session', record.reportId!), false)
  } finally { await f.close() }
})

await check('追加报告后清空保留回流记录，删除并重建会话会移除记录', async () => {
  const f = await streamFixture(provider)
  try {
    const store = freshStore(f)
    store.append('receipt-session', [{ role: 'system', content: '[子任务报告 append-id]\n结果' }])
    assert(freshStore(f).hasReportReceipt('receipt-session', 'append-id'))
    assert.equal(freshStore(f).listSessions(10).find((session) => session.id === 'receipt-session')?.count, 1)
    store.replace('receipt-session', [])
    assert(freshStore(f).hasReportReceipt('receipt-session', 'append-id'))
    assert.equal(freshStore(f).listSessions(10).find((session) => session.id === 'receipt-session')?.count, 0)
    assert(store.removeById('receipt-session'))
    store.replace('receipt-session', [])
    assert.equal(store.hasReportReceipt('receipt-session', 'append-id'), false)
  } finally { await f.close() }
})

await check('压缩历史的冲突副本继承本地回流记录，不继承外部新回流记录', async () => {
  const f = await streamFixture(provider)
  try {
    const local = freshStore(f)
    local.append('source-session', [{ role: 'system', content: '[子任务报告 local-report]\n本地结果' }])
    local.replace('source-session', [{ role: 'system', content: '已摘要' }])
    const external = freshStore(f)
    external.append('source-session', [{ role: 'system', content: '[子任务报告 external-report]\n外部结果' }])
    assert(local.hasReportReceipt('source-session', 'external-report'))
    const copy = local.saveConflictCopy('source-session', [{ role: 'system', content: '本地摘要副本' }])
    assert(freshStore(f).hasReportReceipt(copy, 'local-report'))
    assert.equal(freshStore(f).hasReportReceipt(copy, 'external-report'), false)
  } finally { await f.close() }
})

await check('原子替换失败保留旧历史和回流记录，重试可正常保存', async () => {
  const f = await streamFixture(provider)
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
  const originalRename = fs.renameSync
  try {
    const record = await f.finished(await f.child('child'))
    const file = join(f.root, 'sessions', `${f.memory.sessionId}.jsonl`)
    const before = readFileSync(file, 'utf8')
    fs.renameSync = (source, target) => {
      if (String(target) === file) throw Object.assign(new Error('REPLACE-DENIED'), { code: 'EACCES' })
      return originalRename(source, target)
    }
    syncBuiltinESMExports()
    assert.throws(() => f.store.replace(f.memory.sessionId, []), /REPLACE-DENIED/)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, record.reportId!))
    assert(!readdirSync(join(f.root, 'sessions')).some((name) => name.startsWith('.meicode-write-')))
    fs.renameSync = originalRename
    syncBuiltinESMExports()
    f.store.replace(f.memory.sessionId, [])
    assert.deepEqual(freshStore(f).recoverById(f.memory.sessionId)?.messages, [])
    assert(freshStore(f).hasReportReceipt(f.memory.sessionId, record.reportId!))
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); await f.close() }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
