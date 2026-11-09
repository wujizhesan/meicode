import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
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
  // 预算是等待上限而非耗时：条件满足即返回，只有真失败才走满。
  // 原来 2500ms 在 CI 负载下会偶发超时（与 team_shutdown_outcome_test 同一模式）。
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('团队补存恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['once', 'timer', 'restart', 'restart-blocked', 'lost-lease', 'cancel-pending'] as const) {
  await check('团队终态 ' + mode + ' 只重试保存，真实写入和模型只执行一次', async () => {
    let models = 0, effects = 0, faults = 0, blocked = true, hooksRun = 0
    const hooks = new HookEngine([])
    hooks.fire = async (event) => { if (event === 'task_completed') hooksRun++ }
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++
      if (models % 2 === 1) yield { type: 'tool_call', id: `effect-${models}`, name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'WORK-ALREADY-COMPLETED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider, { hooks })
    const teamRoot = join(f.root, 'team')
    const store = new TeamGroupStore(teamRoot)
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options)
    const original = fs.renameSync
    let fresh: TeamManager | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const effectsFile = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(effectsFile, 'EFFECT\n', 'utf8'); return { success: true, output: 'EFFECT-SAVED' }
      } })
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'WRITE-ONCE', undefined, [], 2)
      const file = join(teamRoot, 'audit', 'tasks.json')
      fs.renameSync = ((source, destination) => {
        if (String(destination).toLowerCase() === file.toLowerCase() && String(source).endsWith('.tmp') && blocked) {
          const records = JSON.parse(fs.readFileSync(source, 'utf8'))
          if (records.some((record: { id: string; status: string }) => record.id === task.id && record.status !== 'in_progress')) {
            faults++
            if (mode === 'once' && faults === 2) blocked = false
            throw Object.assign(new Error('TEAM-TERMINAL-EIO'), { code: 'EIO' })
          }
        }
        return original(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      const result = await bounded(team.runTask(group, task, 'alice'))
      assert.match(result, /WORK-ALREADY-COMPLETED/)
      assert.equal(effects, 1)
      assert.equal(models, 2)
      const reportId = store.loadTaskSettlements(group.name)[0]?.reportId
      if (mode !== 'once') {
        assert.match(result, /待保存/)
        assert(reportId)
        assert.equal(store.listTasks(group.name)[0].status, 'in_progress')
        assert.equal(store.listTasks(group.name)[0].attempt, 1)
        assert.equal(hooksRun, 0)
      }
      if (mode === 'cancel-pending') assert(team.cancelTask(group.name, task.id))
      if (mode === 'restart' || mode === 'restart-blocked') {
        await bounded(team.close(0))
        blocked = false
        store.mutateTasks(group.name, (tasks) => { tasks[0].leaseExpiresAt = 1 })
        if (mode === 'restart-blocked') blocked = true
        fresh = new TeamManager(teamRoot, f.root, options)
        await fresh.restore([])
        if (mode === 'restart-blocked') {
          assert.equal(fresh.listTasks(group.name)[0].status, 'in_progress')
          assert.deepEqual(fresh.recoverStaleTasks(group.name), [])
          assert.equal(models, 2)
          blocked = false
        }
      } else if (mode === 'lost-lease') {
        blocked = false
        store.mutateTasks(group.name, (tasks) => { tasks[0].leaseId = 'NEW-LEASE'; tasks[0].result = 'NEW-OWNER-RESULT' })
      } else blocked = false
      const target = fresh ?? team
      if (mode === 'timer') await waitUntil(() => store.listTasks(group.name)[0].status === 'done')
      else target.listTasks(group.name)
      await tick()
      const final = target.listTasks(group.name)[0]
      if (mode === 'lost-lease') {
        assert.equal(final.status, 'in_progress')
        assert.equal(final.leaseId, 'NEW-LEASE')
        assert.equal(final.result, 'NEW-OWNER-RESULT')
      } else {
        assert.equal(final.status, mode === 'cancel-pending' ? 'cancelled' : 'done')
        assert.equal(final.attempt, 1)
        assert.equal(final.nextRetryAt, undefined)
        assert.equal(final.leaseId, undefined)
        if (mode !== 'cancel-pending') {
          assert.equal(final.result, 'WORK-ALREADY-COMPLETED')
          if (reportId) assert.equal(final.reportId, reportId)
        }
      }
      assert.equal(hooksRun, mode === 'once' || mode === 'timer' ? 1 : 0)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
      assert.equal(models, 2)
      assert.equal(effects, 1)
      assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'EFFECT\n')
    } finally {
      blocked = false; fs.renameSync = original; syncBuiltinESMExports()
      await fresh?.close(1000); await team.close(1000); await f.close()
    }
  })
}

for (const mode of ['restart', 'restart-blocked', 'before-restore', 'lost-lease'] as const) {
  await check('团队取消日志 ' + mode + ' 恢复后不重新派发已取消任务', async () => {
    const started = deferred(), gate = deferred()
    let models = 0, blocked = true, signal: AbortSignal | undefined
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++; signal = options.signal; started.resolve()
      if (models === 1) await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return
      yield { type: 'text', text: 'SHOULD-NOT-RUN' }; yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    const teamRoot = join(f.root, 'team')
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options)
    const other = new TeamGroupStore(teamRoot)
    const original = fs.renameSync
    let fresh: TeamManager | undefined, execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'CANCEL-ME', undefined, [], 2)
      execution = team.runTask(group, task, 'alice')
      await bounded(started.promise)
      const file = join(teamRoot, 'audit', 'tasks.json')
      fs.renameSync = ((source, destination) => {
        if (String(destination).toLowerCase() === file.toLowerCase() && String(source).endsWith('.tmp') && blocked) {
          throw Object.assign(new Error('TEAM-CANCEL-EIO'), { code: 'EIO' })
        }
        return original(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      assert(team.cancelTask(group.name, task.id))
      assert.equal(signal?.aborted, true)
      await bounded(execution)
      const journal = other.loadTaskSettlements(group.name)
      assert.equal(journal[0].kind, 'cancel')
      const reportId = journal[0].reportId
      await bounded(team.close(0))
      blocked = false
      other.mutateTasks(group.name, (tasks) => {
        if (mode === 'lost-lease') { tasks[0].leaseId = 'NEW-LEASE'; tasks[0].result = 'NEW-OWNER-RESULT' }
        else tasks[0].leaseExpiresAt = 1
      })
      if (mode === 'restart-blocked') blocked = true
      fresh = new TeamManager(teamRoot, f.root, options)
      if (mode === 'before-restore') {
        assert.equal(fresh.listTasks(group.name)[0].status, 'cancelled')
        assert.equal(models, 1)
      }
      await fresh.restore([])
      if (mode === 'restart-blocked') {
        assert.equal(fresh.listTasks(group.name)[0].status, 'in_progress')
        assert.deepEqual(fresh.recoverStaleTasks(group.name), [])
        assert.equal(models, 1)
        blocked = false
      }
      const final = fresh.listTasks(group.name)[0]
      if (mode === 'lost-lease') {
        assert.equal(final.status, 'in_progress')
        assert.equal(final.leaseId, 'NEW-LEASE')
        assert.equal(final.result, 'NEW-OWNER-RESULT')
      } else {
        assert.equal(final.status, 'cancelled')
        assert.equal(final.reportId, reportId)
        assert.equal(final.attempt, 1)
        assert.equal(final.nextRetryAt, undefined)
      }
      assert.equal(models, 1)
      assert.deepEqual(other.loadTaskSettlements(group.name), [])
    } finally {
      blocked = false; fs.renameSync = original; syncBuiltinESMExports(); gate.resolve()
      await fresh?.close(1000); await team.close(1000); await Promise.allSettled([execution]); await f.close()
    }
  })
}

await check('团队日志读错误不隔离，真实损坏隔离且错误结果结构拒绝写入', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider)
  const store = new TeamGroupStore(join(f.root, 'team'))
  const original = fs.readFileSync
  try {
    store.createGroup('audit', 'lead')
    const entry = { kind: 'cancel' as const, groupName: 'audit', taskId: '../task', memberName: 'alice', leaseId: 'lease', reportId: 'report' }
    store.saveTaskSettlement(entry)
    const directory = join(f.root, 'team', 'audit', 'tasks.pending')
    const name = fs.readdirSync(directory)[0]
    assert.match(name, /^[a-f0-9]{64}\.json$/)
    const file = join(directory, name)
    fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
      if (String(path) === file) throw Object.assign(new Error('JOURNAL-READ-EACCES'), { code: 'EACCES' })
      return (original as (...args: unknown[]) => unknown)(path, ...args)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    assert.throws(() => store.loadTaskSettlements('audit'), /JOURNAL-READ/)
    assert(fs.existsSync(file))
    fs.readFileSync = original; syncBuiltinESMExports()
    assert.deepEqual(store.loadTaskSettlements('audit'), [entry])
    fs.writeFileSync(file, '{BROKEN')
    assert.deepEqual(store.loadTaskSettlements('audit'), [])
    assert(fs.readdirSync(directory).some((file) => file.includes('.corrupt.')))
    assert.deepEqual(store.listTasks('audit'), [])
    assert.throws(() => store.saveTaskSettlement({ ...entry, kind: 'result', result: { status: 'done', text: 'result', report: { reportId: 'OTHER', status: 'done', summary: 'result' } } }), /非法/)
    const relative = new TeamGroupStore('relative-team')
    relative.createGroup('audit', 'lead')
    relative.saveTaskSettlement(entry)
    assert.deepEqual(relative.loadTaskSettlements('audit'), [entry])
    relative.deleteTaskSettlement(entry)
    assert.deepEqual(relative.loadTaskSettlements('audit'), [])
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); await f.close() }
})

await check('真实模型失败仍按策略重试，成功后不重复执行或留下补存日志', async () => {
  let models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    if (++models === 1) throw new Error('REAL-MODEL-FAILURE')
    yield { type: 'text', text: 'RETRY-SUCCEEDED' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  const teamRoot = join(f.root, 'team')
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'REAL-RETRY', undefined, [], 2)
    await bounded(team.runTask(group, task, 'alice'))
    assert.equal(team.listTasks(group.name)[0].status, 'todo')
    assert.equal(models, 1)
    await waitUntil(() => team.listTasks(group.name)[0].status === 'done')
    assert.equal(team.listTasks(group.name)[0].attempt, 2)
    assert.equal(team.listTasks(group.name)[0].result, 'RETRY-SUCCEEDED')
    assert.equal(models, 2)
    assert.deepEqual(new TeamGroupStore(teamRoot).loadTaskSettlements(group.name), [])
  } finally { await team.close(1000); await f.close() }
})

for (const mode of ['write', 'cleanup'] as const) {
  await check('团队日志 ' + mode + ' 故障不改变已保存结果或重复完成 Hook', async () => {
    let models = 0, hooksRun = 0
    const hooks = new HookEngine([])
    hooks.fire = async (event) => { if (event === 'task_completed') hooksRun++ }
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'PRIMARY-SAVED' }; yield { type: 'done' } } }
    const f = await streamFixture(provider, { hooks })
    const teamRoot = join(f.root, 'team')
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options)
    const originalRename = fs.renameSync, originalUnlink = fs.unlinkSync
    let fresh: TeamManager | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'JOURNAL-FAULT', undefined, [], 2)
      const directory = join(teamRoot, 'audit', 'tasks.pending')
      if (mode === 'write') fs.renameSync = ((source, destination) => {
        if (String(destination).startsWith(directory)) throw Object.assign(new Error('JOURNAL-WRITE-EIO'), { code: 'EIO' })
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      else fs.unlinkSync = ((file) => {
        if (String(file).startsWith(directory) && String(file).endsWith('.json')) throw Object.assign(new Error('JOURNAL-CLEANUP-EACCES'), { code: 'EACCES' })
        return originalUnlink(file)
      }) as typeof fs.unlinkSync
      syncBuiltinESMExports()
      assert.equal(await bounded(team.runTask(group, task, 'alice')), 'PRIMARY-SAVED')
      const final = team.listTasks(group.name)[0]
      assert.equal(final.status, 'done')
      assert.equal(final.attempt, 1)
      fresh = new TeamManager(teamRoot, f.root, options)
      assert.deepEqual(JSON.parse(JSON.stringify(fresh.listTasks(group.name)[0])), JSON.parse(JSON.stringify(final)))
      assert.equal(models, 1)
      assert.equal(hooksRun, 1)
      fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports()
      fresh.listTasks(group.name)
      assert.deepEqual(new TeamGroupStore(teamRoot).loadTaskSettlements(group.name), [])
    } finally {
      fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports()
      await fresh?.close(1000); await team.close(1000); await f.close()
    }
  })
}

console.log(`team_settlement_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
