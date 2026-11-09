import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { SubAgentManager, SubAgentStore } from '../src/subagent/index.ts'
import type { SubAgentRecord } from '../src/subagent/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0
let failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name + ': ' + String(error)) }
}
const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
const record = (sessionId: string, status: SubAgentRecord['status'] = 'running'): SubAgentRecord => ({
  id: 'external-task', sessionId, role: 'worker', type: 'fork', status, startedAt: Date.now(),
  ...(status === 'created' || status === 'running' ? { ownerId: 'external-owner', leaseExpiresAt: Date.now() + 60000 } : {}),
})

for (const mode of ['complete', 'timeout', 'cancel', 'switch-session', 'switch-default-session']) await check('等待另一管理器实际运行的任务 ' + mode, async () => {
  const started = deferred(), gate = deferred()
  const childProvider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    started.resolve()
    await resolveOnAbort(gate.promise, options.signal, undefined)
    yield { type: 'text', text: 'EXTERNAL-WAIT-DONE' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  const other = new SubAgentManager({ builtin: join(f.root, 'none'), user: join(f.root, 'none'), project: join(f.root, 'roles') },
    null, new SubAgentStore(join(f.root, 'subagents'), f.memory.sessionId))
  other.loadRoles()
  try {
    const sid = f.memory.sessionId
    const submitted = await other.spawn({ type: 'defined', role: 'probe', prompt: 'EXTERNAL-WAIT', async: true },
      { provider: childProvider, registry: f.registry, ctx: f.chat.getToolContext() })
    assert(!submitted.error)
    await bounded(started.promise)
    let settled = false
    const before = performance.now()
    const pending = f.manager.waitFor(submitted.id, mode === 'timeout' ? 40 : 2000, mode === 'switch-default-session' ? undefined : sid)
      .then((result) => { settled = true; return result })
    await tick()
    assert.equal(settled, false)
    if (mode.startsWith('switch-')) {
      f.subStore.forSession('another-session').save({ ...record('another-session', 'done'), id: submitted.id, result: 'WRONG-SESSION-RESULT' })
      f.manager.setSession('another-session')
    }
    if (mode === 'cancel') assert(f.manager.cancel(submitted.id, sid))
    else if (mode !== 'timeout') gate.resolve()
    const waited = await bounded(pending)
    if (mode === 'timeout') {
      assert.equal(waited.timedOut, true)
      assert.equal(waited.record?.status, 'running')
      assert(performance.now() - before >= 35)
      gate.resolve()
    } else {
      assert.equal(waited.timedOut, false)
      assert.equal(waited.record?.status, mode === 'cancel' ? 'cancelled' : 'done')
      assert.equal(waited.record?.sessionId, sid)
      if (mode !== 'cancel') assert.equal(waited.record?.result, 'EXTERNAL-WAIT-DONE')
    }
    await bounded(other.waitFor(submitted.id, 2000, sid))
  } finally { gate.resolve(); await other.close(1000); await f.close() }
})

await check('created 外部任务继续等待到终态', async () => {
  const f = await streamFixture(provider)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const original = record(f.memory.sessionId, 'created')
    f.subStore.save(original)
    timer = setTimeout(() => f.subStore.save({ ...record(f.memory.sessionId, 'done'), result: 'CREATED-DONE' }, original.ownerId), 30)
    const waited = await bounded(f.manager.waitFor(original.id, 2000, f.memory.sessionId))
    assert.equal(waited.record?.status, 'done')
    assert.equal(waited.record?.result, 'CREATED-DONE')
    assert.equal(waited.timedOut, false)
  } finally { clearTimeout(timer); await f.close() }
})

await check('等待期间租约过期收敛为 error 而不是假超时', async () => {
  const f = await streamFixture(provider)
  try {
    const original = { ...record(f.memory.sessionId), leaseExpiresAt: Date.now() + 40 }
    f.subStore.save(original)
    const waited = await bounded(f.manager.waitFor(original.id, 2000, f.memory.sessionId))
    assert.equal(waited.timedOut, false)
    assert.equal(waited.record?.status, 'error')
    assert.match(waited.record?.error ?? '', /租约过期/)
    assert.equal(waited.record?.ownerId, undefined)
  } finally { await f.close() }
})

for (const status of ['created', 'running'] as const) await check(status + ' 外部任务零超时返回 timedOut=true', async () => {
  const f = await streamFixture(provider)
  try {
    const original = record(f.memory.sessionId, status)
    f.subStore.save(original)
    const waited = await bounded(f.manager.waitFor(original.id, 0, f.memory.sessionId))
    assert.equal(waited.record?.status, status)
    assert.equal(waited.timedOut, true)
  } finally { await f.close() }
})

for (const status of ['done', 'error', 'cancelled', 'timed_out'] as const) await check(status + ' 终态即使零超时也立即返回 timedOut=false', async () => {
  const f = await streamFixture(provider)
  try {
    const original = record(f.memory.sessionId, status)
    f.subStore.save(original)
    const waited = await bounded(f.manager.waitFor(original.id, 0, f.memory.sessionId))
    assert.equal(waited.record?.status, status)
    assert.equal(waited.timedOut, false)
  } finally { await f.close() }
})

await check('不存在的任务和错误会话立即返回 undefined，不等待其他会话同名任务', async () => {
  const f = await streamFixture(provider)
  try {
    f.subStore.save(record(f.memory.sessionId))
    assert.deepEqual(await bounded(f.manager.waitFor('missing-task', 0, f.memory.sessionId)), { record: undefined, timedOut: false })
    assert.deepEqual(await bounded(f.manager.waitFor('external-task', 0, 'wrong-session')), { record: undefined, timedOut: false })
  } finally { await f.close() }
})

console.log('subagent_external_wait_test: ' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
