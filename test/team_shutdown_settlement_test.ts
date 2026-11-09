import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  // 预算是等待上限而非耗时：条件满足即返回，只有真失败才会走满。
  // 2500ms 在 CI 负载下会偶发超时，与其它恢复等待统一放宽。
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('团队关闭重排恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['normal', 'restart', 'restart-blocked', 'lost-lease'] as const) {
  await check('关闭重排 ' + mode + ' 保留原意图和执行次数，新租约不被覆盖', async () => {
    const started = deferred(), gate = deferred()
    let models = 0, blocked = mode !== 'normal'
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++; started.resolve()
      if (models === 1) await resolveOnAbort(gate.promise, options.signal, undefined)
      if (options.signal?.aborted) return
      yield { type: 'text', text: 'RESTARTED-COMPLETED' }; yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options)
    const original = fs.renameSync
    let fresh: TeamManager | undefined, execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'SHUTDOWN-INTERRUPTED', 'alice', [], 1)
      const file = join(teamRoot, 'audit', 'tasks.json')
      fs.renameSync = ((source, destination) => {
        if (blocked && String(destination) === file && String(source).endsWith('.tmp')) {
          const records = JSON.parse(fs.readFileSync(source, 'utf8'))
          if (records.some((item: { id: string; status: string }) => item.id === task.id && item.status !== 'in_progress')) {
            throw Object.assign(new Error('SHUTDOWN-TERMINAL-EIO'), { code: 'EIO' })
          }
        }
        return original(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      execution = team.runTask(group, task, 'alice')
      await bounded(started.promise)
      await bounded(team.close(1000))
      await bounded(execution)
      assert.equal(models, 1)
      if (mode === 'normal') {
        assert.equal(store.listTasks(group.name)[0].status, 'todo')
        assert.equal(store.listTasks(group.name)[0].attempt, 0)
      } else {
        assert.equal(store.listTasks(group.name)[0].status, 'in_progress')
        assert.equal(store.loadTaskSettlements(group.name)[0].requeueOnShutdown, true)
        assert.equal(store.loadTaskSettlements(group.name)[0].result?.status, 'failed')
      }
      store.mutateTasks(group.name, (tasks) => {
        tasks[0].leaseExpiresAt = mode === 'lost-lease' ? Date.now() + 100000 : 1
        if (mode === 'lost-lease') { tasks[0].leaseId = 'NEW-LEASE'; tasks[0].activeAgentId = 'NEW-AGENT'; tasks[0].result = 'NEW-OWNER' }
      })
      blocked = mode === 'restart-blocked'
      fresh = new TeamManager(teamRoot, f.root, options)
      if (mode === 'restart-blocked') {
        await fresh.restore([])
        assert.equal(fresh.listTasks(group.name)[0].status, 'in_progress')
        assert.deepEqual(fresh.recoverStaleTasks(group.name), [])
        assert.equal(models, 1)
        assert.equal(store.loadTaskSettlements(group.name)[0].requeueOnShutdown, true)
        blocked = false
      }
      const restored = fresh.listTasks(group.name)[0]
      if (mode === 'lost-lease') {
        assert.equal(restored.status, 'in_progress')
        assert.equal(restored.leaseId, 'NEW-LEASE')
        assert.equal(restored.activeAgentId, 'NEW-AGENT')
        assert.equal(restored.result, 'NEW-OWNER')
        assert.equal(restored.attempt, 1)
        assert.equal(fresh.readLeadMail().filter((message) => message.taskId === task.id).length, 0)
        assert.equal(models, 1)
      } else {
        assert.equal(restored.status, 'todo')
        assert.equal(restored.attempt, 0)
        assert.equal(fresh.readLeadMail().filter((message) => message.taskId === task.id && message.kind === 'task_retry').length, 1)
        await fresh.restore([])
        await waitUntil(() => fresh!.listTasks(group.name)[0].status === 'done')
        assert.equal(fresh.listTasks(group.name)[0].attempt, 1)
        assert.equal(fresh.listTasks(group.name)[0].result, 'RESTARTED-COMPLETED')
        assert.equal(models, 2)
      }
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally {
      blocked = false; fs.renameSync = original; syncBuiltinESMExports(); gate.resolve()
      await team.close(1000); await Promise.allSettled([execution]); await fresh?.close(1000); await f.close()
    }
  })
}

console.log(`team_shutdown_settlement_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
