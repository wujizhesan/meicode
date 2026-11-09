import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { SubAgentStore } from '../src/subagent/store.ts'
import type { SubAgentRecord } from '../src/subagent/types.ts'
import { SubAgentResults } from '../src/tui/subagent-results.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}

for (const mode of ['timer', 'session', 'local-cancel', 'external-cancel', 'lost-owner', 'closed', 'expired-io', 'hook-close'] as const) {
  await check('待保存结果 ' + mode + ' 恢复保留真实结果、原会话和 owner，不重复运行或回流', async () => {
    const started = deferred(), gate = deferred(), notified = deferred()
    let models = 0, blocked = true, failures = 0
    const notices: SubAgentRecord[] = [], reports: string[] = [], owners: string[] = []
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++
      started.resolve()
      await gate.promise
      yield { type: 'text', text: 'RESULT-PRESERVED-THROUGH-OUTAGE' }
      yield { type: 'done' }
    } }
    const stopStarted = deferred(), stopGate = deferred()
    const hooks = new HookEngine([])
    hooks.fire = async (event) => { if (mode === 'hook-close' && event === 'subagent_stop') { stopStarted.resolve(); await stopGate.promise } }
    const f = await streamFixture(provider, { hooks })
    const originalRename = fs.renameSync, originalSave = f.subStore.save
    const originalInterval = globalThis.setInterval, originalNow = Date.now
    let heartbeat: (() => void) | undefined
    globalThis.setInterval = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 10000) heartbeat = () => handler(...args)
      return originalInterval(handler, delay, ...args)
    }) as typeof setInterval
    try {
      f.manager.setOnResult((record) => { notices.push(record); notified.resolve() })
      const id = await f.child('SAVE-OUTAGE')
      await bounded(started.promise)
      globalThis.setInterval = originalInterval
      const before = f.subStore.get(id)!
      const file = join(f.root, 'subagents', `${f.memory.sessionId}.json`)
      fs.renameSync = ((source, destination) => {
        if (String(destination).toLowerCase() === file.toLowerCase() && blocked) {
          const records = JSON.parse(fs.readFileSync(source, 'utf8')) as SubAgentRecord[]
          if (records.some((record) => record.id === id && (mode === 'expired-io' || record.status !== 'running'))) {
            failures++
            throw Object.assign(new Error('PENDING-SAVE-EIO'), { code: 'EIO' })
          }
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      f.subStore.save = (record, owner) => {
        if (owner) { owners.push(owner); reports.push(record.reportId!) }
        return originalSave.call(f.subStore, record, owner)
      }
      const waiting = f.manager.waitFor(id, 350)
      gate.resolve()
      const pending = await bounded(waiting)
      assert.equal(pending.timedOut, true)
      assert.equal(pending.record?.status, 'saving')
      assert.equal(pending.record?.result, 'RESULT-PRESERVED-THROUGH-OUTAGE')
      // 保存重试只有 SUBAGENT_SAVE_ATTEMPTS(3) 次、每次退避 100ms。断言"重试已耗尽"
      // 不能靠固定 350ms 采样——负载下最后一次会落在窗口外（CI 与本地都会偶发）。
      // 改为有界轮询，等到重试次数真的耗尽再断言。
      for (let i = 0; i < 500 && failures < 3; i++) await new Promise<void>((done) => setTimeout(done, 10))
      assert(failures >= 3, `保存重试未耗尽: ${failures}/3`)
      assert.equal(notices.length, 0)
      assert.equal(new SubAgentResults().receive(pending.record!, f.memory.sessionId, f.history, f.store), null)
      const other = new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId)
      if (mode === 'session') {
        f.manager.setSession('later-session')
        assert.equal(f.manager.getRecord(id, f.memory.sessionId)?.status, 'saving')
      }
      if (mode === 'local-cancel') assert(f.manager.cancel(id, f.memory.sessionId))
      if (mode === 'external-cancel') assert(other.requestCancel(id, 'EXTERNAL-CANCEL')?.cancelRequestedAt)
      if (mode === 'expired-io') {
        assert(heartbeat)
        Date.now = () => before.leaseExpiresAt! + 1
        heartbeat()
        Date.now = originalNow
        assert.equal(f.manager.getRecord(id, f.memory.sessionId)?.status, 'saving')
      }
      if (mode === 'closed') {
        await bounded(f.manager.close(0))
        assert.equal(f.manager.getRecord(id, f.memory.sessionId)?.status, 'saving')
      }
      blocked = false
      if (mode === 'lost-owner') other.reclaimExpired(id, before.leaseExpiresAt! + 1)
      if (mode === 'timer') await bounded(notified.promise)
      if (mode === 'hook-close') {
        f.manager.getRecord(id)
        await bounded(stopStarted.promise)
        await bounded(f.manager.close(1000))
        await bounded(notified.promise)
      }
      const result = await bounded(f.manager.waitFor(id, 1500, f.memory.sessionId))
      await tick()
      await tick()
      assert.equal(result.timedOut, false)
      assert.equal(models, 1)
      assert.equal(new Set(owners).size, 1)
      assert.equal(owners[0], before.ownerId)
      assert.equal(new Set(reports).size, 1)
      if (mode === 'lost-owner') {
        assert.equal(result.record?.status, 'error')
        assert.equal(result.record?.result, undefined)
        assert.equal(notices.length, 0)
      } else {
        const expected = mode.endsWith('cancel') ? 'cancelled' : 'done'
        assert.equal(result.record?.status, expected)
        assert.equal(result.record?.result, 'RESULT-PRESERVED-THROUGH-OUTAGE')
        assert.equal(result.record?.ownerId, undefined)
        assert.equal(notices.length, 1)
        assert.equal(notices[0].status, expected)
        assert.equal(notices[0].sessionId, f.memory.sessionId)
        if (expected === 'done') assert.equal(result.record?.error, undefined)
        else assert(result.record?.cancelRequestedAt)
        if (mode === 'external-cancel') assert.equal(result.record?.cancelReason, 'EXTERNAL-CANCEL')
        assert.equal(f.subStore.get(id)?.status, expected)
      }
      f.manager.listRecords(f.memory.sessionId)
      f.manager.getRecord(id, f.memory.sessionId)
      await tick()
      assert.equal(notices.length, mode === 'lost-owner' ? 0 : 1)
      if (mode === 'session') assert.equal(f.subStore.forSession('later-session').get(id), null)
    } finally {
      blocked = false
      Date.now = originalNow
      globalThis.setInterval = originalInterval
      f.subStore.save = originalSave
      fs.renameSync = originalRename
      syncBuiltinESMExports()
      gate.resolve()
      stopGate.resolve()
      await f.close()
    }
  })
}

console.log(`subagent_pending_save_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
