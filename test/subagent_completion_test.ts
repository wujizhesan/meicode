import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { SubAgentStore } from '../src/subagent/store.ts'
import type { SubAgentRecord } from '../src/subagent/types.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}

function renameFault(file: string, limit: number) {
  const original = fs.renameSync
  let failures = 0
  fs.renameSync = ((source, destination) => {
    if (String(destination).toLowerCase() === file.toLowerCase() && failures < limit) {
      failures++
      throw Object.assign(new Error('COMPLETION-SAVE-EIO'), { code: 'EIO' })
    }
    return original(source, destination)
  }) as typeof fs.renameSync
  syncBuiltinESMExports()
  return { get failures() { return failures }, restore() { fs.renameSync = original; syncBuiltinESMExports() } }
}

for (const mode of ['transient', 'expired', 'lost-owner'] as const) {
  await check('续期 ' + mode + ' 区分暂时 I/O 故障、到期及所有权丢失', async () => {
    const gate = deferred(), started = deferred()
    let signal: AbortSignal | undefined
    const provider: Provider = { protocol: 'openai', async *streamChat(_, options) {
      signal = options.signal
      started.resolve()
      await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return
      yield { type: 'text', text: 'HEARTBEAT-COMPLETED' }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    const originalInterval = globalThis.setInterval, originalNow = Date.now
    let heartbeat: (() => void) | undefined
    globalThis.setInterval = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 10000) heartbeat = () => handler(...args)
      return originalInterval(handler, delay, ...args)
    }) as typeof setInterval
    let fault: ReturnType<typeof renameFault> | undefined
    try {
      const id = await f.child('HEARTBEAT-AUDIT')
      await bounded(started.promise)
      globalThis.setInterval = originalInterval
      assert(heartbeat)
      const other = new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId)
      const before = other.get(id)!
      if (mode === 'lost-owner') other.reclaimExpired(id, before.leaseExpiresAt! + 1)
      else fault = renameFault(join(f.root, 'subagents', `${f.memory.sessionId}.json`), 1)
      if (mode === 'expired') Date.now = () => before.leaseExpiresAt! + 1
      heartbeat()
      Date.now = originalNow
      if (mode === 'transient') {
        assert.equal(signal?.aborted, false)
        assert.equal(other.get(id)?.status, 'running')
        assert.equal(other.get(id)?.leaseExpiresAt, before.leaseExpiresAt)
        Date.now = () => originalNow() + 1000
        heartbeat()
        Date.now = originalNow
        assert(other.get(id)!.leaseExpiresAt! > before.leaseExpiresAt!)
        assert.equal(signal?.aborted, false)
        gate.resolve()
        const result = await f.finished(id)
        assert.equal(result.status, 'done')
        assert.equal(result.result, 'HEARTBEAT-COMPLETED')
      } else {
        assert.equal(signal?.aborted, true)
        assert.equal((await f.finished(id)).status, mode === 'expired' ? 'cancelled' : 'error')
      }
      if (fault) assert.equal(fault.failures, 1)
    } finally {
      Date.now = originalNow
      globalThis.setInterval = originalInterval
      fault?.restore()
      gate.resolve()
      await f.close()
    }
  })
}

for (const mode of ['once', 'twice', 'external-cancel', 'local-cancel', 'lost-owner', 'model-error'] as const) {
  await check('终态保存 ' + mode + ' 保留真实结果及所有权保护，不重复执行或通知', async () => {
    const started = deferred(), gate = deferred()
    let models = 0
    const notifications: SubAgentRecord[] = []
    const provider: Provider = { protocol: 'openai', async *streamChat(_, options) {
      models++
      started.resolve()
      await resolveOnAbort(gate.promise, options.signal, undefined)
      if (options.signal?.aborted) return
      if (mode === 'model-error') { yield { type: 'error', message: 'REAL-MODEL-ERROR' }; return }
      yield { type: 'text', text: 'ACTUALLY-COMPLETED' }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    const originalSave = f.subStore.save
    const attempts: { status: string; owner?: string; reportId?: string }[] = []
    let fault: ReturnType<typeof renameFault> | undefined
    let acted = false
    try {
      f.manager.setOnResult((record) => { notifications.push(record) })
      const id = await f.child('TERMINAL-AUDIT')
      await bounded(started.promise)
      const before = f.subStore.get(id)!
      fault = renameFault(join(f.root, 'subagents', `${f.memory.sessionId}.json`), mode === 'twice' ? 2 : 1)
      f.subStore.save = (record, owner) => {
        attempts.push({ status: record.status, owner, reportId: record.reportId })
        try { return originalSave.call(f.subStore, record, owner) }
        catch (error) {
          if (!acted) {
            acted = true
            const other = new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId)
            if (mode === 'external-cancel') assert(other.requestCancel(id, 'EXTERNAL-CANCEL')?.cancelRequestedAt)
            if (mode === 'local-cancel') assert(f.manager.cancel(id))
            if (mode === 'lost-owner') assert.equal(other.reclaimExpired(id, before.leaseExpiresAt! + 1)?.status, 'error')
          }
          throw error
        }
      }
      gate.resolve()
      const record = await f.finished(id)
      const expected = mode.endsWith('cancel') ? 'cancelled' : mode === 'model-error' || mode === 'lost-owner' ? 'error' : 'done'
      assert.equal(record.status, expected)
      assert.equal(models, 1)
      const terminalAttempts = attempts.filter((attempt) => attempt.owner !== undefined)
      assert.equal(terminalAttempts.length, mode === 'twice' ? 3 : 2)
      assert(terminalAttempts.every((attempt) => attempt.owner === before.ownerId))
      assert.equal(new Set(terminalAttempts.map((attempt) => attempt.reportId)).size, 1)
      assert.equal(record.ownerId, undefined)
      assert.equal(record.leaseExpiresAt, undefined)
      if (mode === 'lost-owner') {
        assert.match(record.error!, /租约过期/)
        assert.equal(record.result, undefined)
        assert.equal(notifications.length, 0)
      } else {
        assert.equal(notifications.length, 1)
        assert.equal(notifications[0].status, expected)
        if (mode === 'model-error') assert.equal(record.error, 'REAL-MODEL-ERROR')
        else assert.equal(record.result, 'ACTUALLY-COMPLETED')
        if (mode.endsWith('cancel')) assert(record.cancelRequestedAt)
        if (mode === 'external-cancel') assert.equal(record.cancelReason, 'EXTERNAL-CANCEL')
        if (expected === 'done') assert.equal(record.error, undefined)
      }
    } finally {
      f.subStore.save = originalSave
      fault?.restore()
      gate.resolve()
      await f.close()
    }
  })
}

await check('持续存档失败转后台补存，保留任务 ID 且恢复后不重跑或虚假成功', async () => {
  const started = deferred(), gate = deferred()
  let notifications = 0, models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    models++
    started.resolve()
    await gate.promise
    yield { type: 'text', text: 'ACTUALLY-COMPLETED' }
    yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  const originalSave = f.subStore.save
  let fault: ReturnType<typeof renameFault> | undefined
  const attempts: { status: string; owner?: string }[] = []
  let execution: ReturnType<typeof f.manager.spawn> | undefined
  try {
    f.manager.setOnResult(() => { notifications++ })
    execution = f.manager.spawn({ type: 'defined', role: 'probe', prompt: 'TERMINAL-AUDIT' }, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    await bounded(started.promise)
    const before = f.manager.listRecords()[0]
    fault = renameFault(join(f.root, 'subagents', `${f.memory.sessionId}.json`), 100)
    f.subStore.save = (record, owner) => {
      attempts.push({ status: record.status, owner })
      return originalSave.call(f.subStore, record, owner)
    }
    gate.resolve()
    const submitted = await bounded(execution)
    assert.equal(submitted.async, true)
    assert.equal(submitted.id, before.id)
    assert.equal(submitted.error, undefined)
    assert.equal(attempts.length, 3)
    assert(attempts.every((attempt) => attempt.status === 'done' && attempt.owner === before.ownerId))
    assert.equal(f.subStore.get(before.id)?.status, 'running')
    assert.equal(notifications, 0)
    assert.equal(models, 1)
    fault.restore()
    const recovered = await f.finished(submitted.id)
    assert.equal(recovered.status, 'done')
    assert.equal(recovered.result, 'ACTUALLY-COMPLETED')
    assert.equal(notifications, 1)
    assert.equal(models, 1)
  } finally {
    f.subStore.save = originalSave
    fault?.restore()
    gate.resolve()
    await Promise.allSettled([execution])
    await f.close()
  }
})

console.log(`subagent_completion_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
