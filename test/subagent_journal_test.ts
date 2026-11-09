import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { SubAgentManager } from '../src/subagent/manager.ts'
import { SubAgentStore } from '../src/subagent/store.ts'
import { SubAgentResults } from '../src/tui/subagent-results.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}

for (const mode of ['restart', 'expired', 'external-cancel', 'local-cancel', 'lost-owner', 'restart-blocked'] as const) {
  await check('终态日志恢复 ' + mode + ' 保留原结果、报告和所有权守卫', async () => {
    const started = deferred(), gate = deferred()
    let models = 0, blocked = true, notices = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++; started.resolve(); await gate.promise
      yield { type: 'text', text: 'DURABLE-COMPLETED-RESULT' }; yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    const original = fs.renameSync
    let fresh: SubAgentManager | undefined, again: SubAgentManager | undefined
    try {
      const id = await f.child('RESTART-PROBE')
      await bounded(started.promise)
      const file = join(f.root, 'subagents', `${f.memory.sessionId}.json`)
      fs.renameSync = ((source, destination) => {
        if (String(destination).toLowerCase() === file.toLowerCase() && blocked) {
          throw Object.assign(new Error('JOURNAL-MAIN-EIO'), { code: 'EIO' })
        }
        return original(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      const waiting = f.manager.waitFor(id, 350)
      gate.resolve()
      const pending = await bounded(waiting)
      assert.equal(pending.record?.status, 'saving')
      assert(pending.timedOut)
      const journal = f.subStore.loadPendingTerminals()
      assert.equal(journal.length, 1)
      assert.equal(journal[0].record.result, 'DURABLE-COMPLETED-RESULT')
      assert(journal[0].record.reportId)
      if (mode === 'local-cancel') assert(f.manager.cancel(id))
      await bounded(f.manager.close(0))
      blocked = false
      const other = new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId)
      if (mode === 'external-cancel') other.requestCancel(id, 'EXTERNAL-CANCEL')
      if (mode === 'lost-owner') other.save({ ...other.get(id)!, ownerId: 'NEW-OWNER', result: 'NEW-OWNER-RESULT' })
      if (mode === 'expired' || mode === 'restart-blocked') other.save({ ...other.get(id)!, leaseExpiresAt: 1 })
      if (mode === 'restart-blocked') blocked = true
      const dirs = { builtin: join(f.root, 'none'), user: join(f.root, 'none'), project: join(f.root, 'none') }
      fresh = new SubAgentManager(dirs, null, other)
      fresh.setOnResult(() => { notices++ })
      if (mode === 'restart-blocked') {
        const stillPending = await fresh.waitFor(id, 50)
        assert(stillPending.timedOut)
        assert.equal(stillPending.record?.status, 'saving')
        assert.equal(stillPending.record?.result, 'DURABLE-COMPLETED-RESULT')
        assert.equal(other.get(id)?.status, 'running')
        blocked = false
      }
      const final = fresh.getRecord(id)!
      if (mode === 'lost-owner') {
        assert.equal(final.ownerId, 'NEW-OWNER')
        assert.equal(final.result, 'NEW-OWNER-RESULT')
        assert.equal(final.status, 'running')
      } else {
        assert.equal(final.status, mode.endsWith('cancel') ? 'cancelled' : 'done')
        assert.equal(final.result, 'DURABLE-COMPLETED-RESULT')
        assert.equal(final.reportId, journal[0].record.reportId)
        assert.equal(final.ownerId, undefined)
        if (mode === 'external-cancel') assert.equal(final.cancelReason, 'EXTERNAL-CANCEL')
        const receiver = new SubAgentResults()
        assert(receiver.receive(final, f.memory.sessionId, f.history, f.store))
        assert.equal(receiver.receive(final, f.memory.sessionId, f.history, f.store), null)
      }
      assert.deepEqual(other.loadPendingTerminals(), [])
      again = new SubAgentManager(dirs, null, other)
      assert.deepEqual(again.getRecord(id), final)
      await tick()
      assert.equal(notices, mode === 'lost-owner' ? 0 : 1)
      assert.equal(models, 1)
    } finally {
      blocked = false; fs.renameSync = original; syncBuiltinESMExports(); gate.resolve()
      await again?.close(0); await fresh?.close(0); await f.close()
    }
  })
}

await check('日志临时读错误传播，损坏日志隔离且不修改主记录', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider)
  const original = fs.readFileSync
  try {
    const record = { id: '../record', role: 'worker', type: 'fork' as const, status: 'done' as const, sessionId: f.memory.sessionId, startedAt: 1, result: 'SAFE' }
    f.subStore.savePendingTerminal(record, 'owner')
    const directory = join(f.root, 'subagents', `${f.memory.sessionId}.json.pending`)
    const name = fs.readdirSync(directory)[0]
    assert.match(name, /^[a-f0-9]{64}\.json$/)
    const file = join(directory, name)
    fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
      if (String(path) === file) throw Object.assign(new Error('JOURNAL-READ-EACCES'), { code: 'EACCES' })
      return (original as (...args: unknown[]) => unknown)(path, ...args)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    assert.throws(() => f.subStore.loadPendingTerminals(), /JOURNAL-READ/)
    assert(fs.existsSync(file))
    fs.readFileSync = original; syncBuiltinESMExports()
    assert.equal(f.subStore.loadPendingTerminals()[0].record.result, 'SAFE')
    fs.writeFileSync(file, '{BROKEN')
    assert.deepEqual(f.subStore.loadPendingTerminals(), [])
    assert(fs.readdirSync(directory).some((item) => item.includes('.corrupt.')))
    assert.deepEqual(f.subStore.load(), [])
    assert.throws(() => f.subStore.savePendingTerminal({ ...record, sessionId: 'other' }, 'owner'), /非法/)
    const relative = new SubAgentStore('relative-subagents', f.memory.sessionId)
    relative.savePendingTerminal(record, 'owner')
    assert.deepEqual(relative.loadPendingTerminals(), [{ ownerId: 'owner', record }])
    relative.deletePendingTerminal(record.id, 'owner')
    assert.deepEqual(relative.loadPendingTerminals(), [])
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); await f.close() }
})

for (const mode of ['journal-write', 'journal-cleanup'] as const) {
  await check('日志 ' + mode + ' 故障不影响主终态保存或重复执行回流', async () => {
    let models = 0, notices = 0
    const started = deferred(), gate = deferred()
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++; started.resolve(); await gate.promise
      yield { type: 'text', text: 'PRIMARY-SAVED' }; yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    const originalRename = fs.renameSync, originalUnlink = fs.unlinkSync
    let fresh: SubAgentManager | undefined
    try {
      f.manager.setOnResult(() => { notices++ })
      const id = await f.child('JOURNAL-FAULT')
      await bounded(started.promise)
      const directory = join(f.root, 'subagents', `${f.memory.sessionId}.json.pending`)
      if (mode === 'journal-write') fs.renameSync = ((source, destination) => {
        if (String(destination).startsWith(directory)) throw Object.assign(new Error('JOURNAL-WRITE-EIO'), { code: 'EIO' })
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      else fs.unlinkSync = ((file) => {
        if (String(file).startsWith(directory) && String(file).endsWith('.json')) throw Object.assign(new Error('JOURNAL-CLEANUP-EACCES'), { code: 'EACCES' })
        return originalUnlink(file)
      }) as typeof fs.unlinkSync
      syncBuiltinESMExports()
      gate.resolve()
      const final = await f.finished(id)
      assert.equal(final.status, 'done')
      assert.equal(final.result, 'PRIMARY-SAVED')
      assert.equal(notices, 1)
      const other = new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId)
      fresh = new SubAgentManager({ builtin: join(f.root, 'none'), user: join(f.root, 'none'), project: join(f.root, 'none') }, null, other)
      assert.equal(fresh.getRecord(id)?.status, 'done')
      assert.equal(models, 1)
      fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports()
      fresh.getRecord(id)
      assert.deepEqual(other.loadPendingTerminals(), [])
      assert.equal(notices, 1)
    } finally {
      fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); gate.resolve()
      await fresh?.close(0); await f.close()
    }
  })
}

console.log(`subagent_journal_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
