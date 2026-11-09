import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamManager } from '../src/team/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('取消补存超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}
function heldProvider() {
  const started = deferred(), gate = deferred()
  let signal: AbortSignal | undefined, models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; signal = options.signal; started.resolve()
    await resolveOnAbort(gate.promise, signal, undefined)
    if (signal?.aborted) return
    yield { type: 'text', text: '完成' }; yield { type: 'done' }
  } }
  return { provider, started, gate, get signal() { return signal }, get models() { return models } }
}

for (const mode of ['read', 'write'] as const) {
  await check('子任务取消遇到 ' + mode + ' 故障先停止模型，恢复后只补存取消状态', async () => {
    const held = heldProvider()
    const f = await streamFixture(held.provider)
    const originalRename = fs.renameSync, originalStat = fs.statSync
    let faults = 0
    try {
      const id = await f.child('CANCEL-PROBE')
      await bounded(held.started.promise)
      assert.equal(f.manager.cancel(id, 'wrong-session'), false)
      assert.equal(held.signal?.aborted, false)
      const file = join(f.root, 'subagents', `${f.memory.sessionId}.json`)
      if (mode === 'write') fs.renameSync = ((source, destination) => {
        if (String(destination).toLowerCase() === file.toLowerCase()) {
          faults++; throw Object.assign(new Error('CANCEL-WRITE-EIO'), { code: 'EIO' })
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      else fs.statSync = ((path: unknown, ...args: unknown[]) => {
        if (String(path).toLowerCase() === file.toLowerCase()) {
          faults++; throw Object.assign(new Error('CANCEL-READ-EACCES'), { code: 'EACCES' })
        }
        return (originalStat as (...args: unknown[]) => unknown)(path, ...args)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
      assert(f.manager.cancel(id))
      assert.equal(held.signal?.aborted, true)
      assert(faults > 0)
      await tick()
      if (mode === 'write') {
        const saving = await bounded(f.manager.waitFor(id, 350))
        assert(saving.timedOut)
        assert.equal(saving.record?.status, 'saving')
        assert.equal(f.subStore.loadPendingTerminals()[0]?.record.status, 'cancelled')
      }
      fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports()
      const final = await f.finished(id)
      assert.equal(final.status, 'cancelled')
      assert(final.cancelRequestedAt)
      assert.equal(held.models, 1)
      assert.deepEqual(f.subStore.loadPendingTerminals(), [])
    } finally {
      fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports(); held.gate.resolve()
      await f.close()
    }
  })
}

for (const mode of ['read', 'write', 'lost-lease'] as const) {
  await check('团队取消 ' + mode + ' 故障停止模型、自动补存且不覆盖新租约', async () => {
    const held = heldProvider()
    const f = await streamFixture(held.provider)
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider: held.provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const originalRename = fs.renameSync, originalStat = fs.statSync
    let execution: Promise<string> | undefined, faults = 0
    try {
      const group = team.createGroup('audit', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'CANCEL-PROBE', undefined, [], 2)
      execution = team.runTask(group, task, 'alice')
      await bounded(held.started.promise)
      const file = join(f.root, 'team', 'audit', 'tasks.json')
      if (mode === 'read') fs.statSync = ((path: unknown, ...args: unknown[]) => {
        if (String(path).toLowerCase() === file.toLowerCase()) {
          faults++; throw Object.assign(new Error('TEAM-CANCEL-READ-EACCES'), { code: 'EACCES' })
        }
        return (originalStat as (...args: unknown[]) => unknown)(path, ...args)
      }) as typeof fs.statSync
      else fs.renameSync = ((source, destination) => {
        if (String(destination).toLowerCase() === file.toLowerCase() && String(source).endsWith('.tmp')) {
          faults++; throw Object.assign(new Error('TEAM-CANCEL-WRITE-EIO'), { code: 'EIO' })
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      assert(team.cancelTask(group.name, task.id))
      assert.equal(held.signal?.aborted, true)
      await bounded(execution)
      assert(!host.isBusy())
      assert(team.cancelTask(group.name, task.id))
      assert(faults > 0)
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].status, 'in_progress')
      fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports()
      if (mode === 'lost-lease') {
        const other = new TeamGroupStore(join(f.root, 'team'))
        other.mutateTasks(group.name, (tasks) => { tasks[0].leaseId = 'NEW-LEASE'; tasks[0].result = 'NEW-OWNER-RESULT' })
        await new Promise((done) => setTimeout(done, 650))
        const final = team.listTasks(group.name)[0]
        assert.equal(final.leaseId, 'NEW-LEASE')
        assert.equal(final.result, 'NEW-OWNER-RESULT')
        assert.equal(final.status, 'in_progress')
      } else {
        await waitUntil(() => team.listTasks(group.name)[0].status === 'cancelled')
        const final = team.listTasks(group.name)[0]
        assert.equal(final.attempt, 1)
        assert.equal(final.nextRetryAt, undefined)
        assert.equal(final.leaseId, undefined)
        assert.equal(final.report?.status, 'cancelled')
        await new Promise((done) => setTimeout(done, 100))
        assert.equal(team.listTasks(group.name)[0].status, 'cancelled')
      }
      assert.equal(held.models, 1)
    } finally {
      fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports(); held.gate.resolve()
      await team.close(1000); await Promise.allSettled([execution]); await f.close()
    }
  })
}

console.log(`cancellation_persistence_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
