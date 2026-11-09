import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  // 预算是等待上限而非耗时：条件满足即返回，只有真失败才会走满。
  // 2500ms 在 CI 负载下会偶发超时，与其它恢复等待统一放宽。
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('等待任务取消恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['retry', 'hook', 'assigned', 'unassigned', 'blocked'] as const) {
  await check('等待任务 ' + mode + ' 取消后不派发、不消耗次数、不产生实际写入', async () => {
    let models = 0, effects = 0
    const started = deferred(), gate = deferred(), hooks = new HookEngine([])
    hooks.fire = async (event) => { if (mode === 'hook' && event === 'task_completed') { started.resolve(); await gate.promise } }
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++
      if (models === 1 && (mode === 'retry' || mode === 'hook')) throw new Error('RETRYABLE-FAILURE')
      if (effects === 0) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'UNEXPECTED-RUN' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider, { hooks })
    const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
    const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const effectsFile = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(effectsFile, 'EFFECT\n'); return { success: true, output: 'EFFECT' }
      } })
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const dependency = mode === 'blocked' ? team.addTask(group.name, 'DEPENDENCY') : undefined
      const task = team.addTask(group.name, 'QUEUED-CANCEL', mode === 'unassigned' ? undefined : 'alice', dependency ? [dependency.id] : [], 2)
      if (mode === 'retry' || mode === 'hook') {
        execution = team.runTask(group, task, 'alice')
        if (mode === 'hook') await bounded(started.promise)
        else await bounded(execution)
      }
      const before = store.listTasks(group.name).find((item) => item.id === task.id)!
      assert.equal(before.status, 'todo')
      const cancelled = team.cancelTask(group.name, task.id)
      gate.resolve(); await Promise.allSettled([execution])
      if (mode === 'retry' || mode === 'hook') await new Promise((done) => setTimeout(done, 1100))
      team.scheduleReadyTasks(group.name)
      assert(cancelled)
      const final = store.listTasks(group.name).find((item) => item.id === task.id)!
      assert.equal(final.status, 'cancelled')
      assert.equal(final.attempt, before.attempt)
      assert.equal(final.nextRetryAt, undefined)
      assert.equal(final.leaseId, undefined)
      assert.equal(models, mode === 'retry' || mode === 'hook' ? 1 : 0)
      assert.equal(effects, 0)
      assert(!fs.existsSync(effectsFile))
      assert.equal(team.readLeadMail().filter((message) => message.taskId === task.id && message.kind === 'task_cancelled').length, 1)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
      assert.equal(team.cancelTask(group.name, task.id), false)
    } finally { gate.resolve(); await team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}

for (const mode of ['timer', 'restart', 'restart-blocked', 'changed', 'read'] as const) {
  await check('等待取消 ' + mode + ' 故障期间禁止派发，恢复不覆盖新任务版本', async () => {
    let models = 0, blocked = true, readBlocked = false
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'NEW-TASK' }; yield { type: 'done' } } }
    const f = await streamFixture(provider)
    const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options)
    const originalRename = fs.renameSync, originalStat = fs.statSync
    let fresh: TeamManager | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'QUEUED-CANCEL', 'alice', [], 2)
      const file = join(teamRoot, 'audit', 'tasks.json')
      fs.renameSync = ((source, destination) => {
        if (blocked && String(destination) === file && String(source).endsWith('.tmp')) {
          const records = JSON.parse(fs.readFileSync(source, 'utf8'))
          if (records.some((record: { status: string }) => record.status === 'cancelled')) throw Object.assign(new Error('QUEUED-CANCEL-EIO'), { code: 'EIO' })
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      fs.statSync = ((path, options) => {
        if (readBlocked && String(path) === file) throw Object.assign(new Error('QUEUED-CANCEL-READ-EACCES'), { code: 'EACCES' })
        return originalStat(path, options)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
      assert(team.cancelTask(group.name, task.id))
      assert.equal(store.listTasks(group.name)[0].status, 'todo')
      assert.equal(store.loadTaskSettlements(group.name).length, 1)
      assert.match(await bounded(team.runTask(group, task, 'alice')), /取消/)
      assert.deepEqual(team.scheduleReadyTasks(group.name), [])
      assert.equal(models, 0)
      assert(team.cancelTask(group.name, task.id))
      if (mode === 'changed') {
        store.mutateTasks(group.name, (tasks) => { tasks[0].title = 'REPLACEMENT'; tasks[0].updatedAt = task.updatedAt! + 1 })
      } else if (mode === 'read') readBlocked = true
      if (mode !== 'timer') {
        await bounded(team.close(0))
        fresh = new TeamManager(teamRoot, f.root, options)
        if (mode === 'restart-blocked' || mode === 'read') {
          await fresh.restore([])
          if (mode === 'read') assert.throws(() => fresh!.scheduleReadyTasks(group.name), /QUEUED-CANCEL-READ-EACCES/)
          else assert.deepEqual(fresh.scheduleReadyTasks(group.name), [])
          assert.equal(models, 0)
          assert.equal(store.loadTaskSettlements(group.name).length, 1)
        }
      }
      blocked = false; readBlocked = false
      const target = fresh ?? team
      if (mode === 'timer') await waitUntil(() => store.listTasks(group.name)[0].status === 'cancelled')
      else target.listTasks(group.name)
      if (mode === 'changed') {
        assert.equal(store.listTasks(group.name)[0].status, 'todo')
        assert.equal(store.listTasks(group.name)[0].title, 'REPLACEMENT')
        await target.restore([])
        await waitUntil(() => store.listTasks(group.name)[0].status === 'done')
        assert.equal(store.listTasks(group.name)[0].result, 'NEW-TASK')
        assert.equal(models, 1)
      } else {
        assert.equal(store.listTasks(group.name)[0].status, 'cancelled')
        assert.equal(store.listTasks(group.name)[0].attempt, 0)
        await target.restore([])
        assert.deepEqual(target.scheduleReadyTasks(group.name), [])
        assert.equal(models, 0)
        assert.equal(target.readLeadMail().filter((message) => message.taskId === task.id && message.kind === 'task_cancelled').length, 1)
      }
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally {
      blocked = false; readBlocked = false; fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports()
      await team.close(1000); await fresh?.close(1000); await f.close()
    }
  })
}

await check('领取前另一实例取消，账本写失败仍阻止实际模型执行', async () => {
  let models = 0, blocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'SHOULD-NOT-RUN' }; yield { type: 'done' } } }
  const f = await streamFixture(provider)
  const teamRoot = join(f.root, 'team'), options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
  const team = new TeamManager(teamRoot, f.root, options), peer = new TeamManager(teamRoot, f.root, options)
  const originalRename = fs.renameSync
  const store = (team as unknown as { store: TeamGroupStore }).store
  const originalClaim = store.claimTask.bind(store)
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'CANCEL-CLAIM-RACE', 'alice', [], 2)
    const file = join(teamRoot, 'audit', 'tasks.json')
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === file && String(source).endsWith('.tmp')) {
        const records = JSON.parse(fs.readFileSync(source, 'utf8'))
        if (records.some((record: { status: string }) => record.status === 'cancelled')) throw Object.assign(new Error('QUEUED-CANCEL-EIO'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    store.claimTask = (groupName, taskId, patch, guard) => {
      assert(peer.cancelTask(groupName, taskId))
      return originalClaim(groupName, taskId, patch, guard)
    }
    await bounded(team.runTask(group, task, 'alice'))
    assert.equal(models, 0)
    assert.equal(store.listTasks(group.name)[0].status, 'todo')
    assert.equal(store.listTasks(group.name)[0].attempt, 0)
    blocked = false
    assert.equal(team.listTasks(group.name)[0].status, 'cancelled')
    peer.listTasks(group.name)
    assert.equal(team.readLeadMail().filter((message) => message.taskId === task.id && message.kind === 'task_cancelled').length, 1)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
  } finally {
    blocked = false; fs.renameSync = originalRename; syncBuiltinESMExports(); store.claimTask = originalClaim
    await peer.close(1000); await team.close(1000); await f.close()
  }
})

await check('同名同版本的其他任务不被取消日志阻塞', async () => {
  let models = 0, blocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'OTHER-TASK-DONE' }; yield { type: 'done' } } }
  const f = await streamFixture(provider)
  const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const originalRename = fs.renameSync
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const first = team.addTask(group.name, 'SAME-TITLE', 'alice', [], 2), second = team.addTask(group.name, 'SAME-TITLE', 'alice', [], 2)
    store.mutateTasks(group.name, (tasks) => { tasks[1].updatedAt = tasks[0].updatedAt })
    const file = join(teamRoot, 'audit', 'tasks.json')
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === file && String(source).endsWith('.tmp')) {
        const records = JSON.parse(fs.readFileSync(source, 'utf8'))
        if (records.some((record: { id: string; status: string }) => record.id === first.id && record.status === 'cancelled')) throw Object.assign(new Error('QUEUED-CANCEL-EIO'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    assert(team.cancelTask(group.name, first.id))
    assert.equal(await bounded(team.runTask(group, second, 'alice')), 'OTHER-TASK-DONE')
    assert.equal(store.listTasks(group.name).find((task) => task.id === second.id)?.status, 'done')
    assert.equal(store.listTasks(group.name).find((task) => task.id === first.id)?.status, 'todo')
    assert.equal(models, 1)
    blocked = false
    assert.equal(team.listTasks(group.name).find((task) => task.id === first.id)?.status, 'cancelled')
    assert.equal(store.listTasks(group.name).find((task) => task.id === second.id)?.status, 'done')
    assert.equal(models, 1)
  } finally { blocked = false; fs.renameSync = originalRename; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})

await check('任务版本变更后再次取消记录新意图，不误报旧取消已成功', async () => {
  let models = 0, blocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
  const f = await streamFixture(provider)
  const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const originalRename = fs.renameSync
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'FIRST-VERSION', 'alice', [], 2), file = join(teamRoot, 'audit', 'tasks.json')
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === file && String(source).endsWith('.tmp')) {
        const records = JSON.parse(fs.readFileSync(source, 'utf8'))
        if (records.some((record: { status: string }) => record.status === 'cancelled')) throw Object.assign(new Error('QUEUED-CANCEL-EIO'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    assert(team.cancelTask(group.name, task.id))
    const firstReportId = store.loadTaskSettlements(group.name)[0].reportId
    store.mutateTasks(group.name, (tasks) => { tasks[0].title = 'SECOND-VERSION'; tasks[0].updatedAt = task.updatedAt! + 1 })
    assert(team.cancelTask(group.name, task.id))
    const records = store.loadTaskSettlements(group.name)
    assert.equal(records.length, 1)
    assert.equal(records[0].queuedTask?.title, 'SECOND-VERSION')
    assert.notEqual(records[0].reportId, firstReportId)
    assert.deepEqual(team.scheduleReadyTasks(group.name), [])
    assert.equal(models, 0)
    blocked = false
    const final = team.listTasks(group.name)[0]
    assert.equal(final.status, 'cancelled')
    assert.equal(final.title, 'SECOND-VERSION')
    assert.equal(final.reportId, records[0].reportId)
    assert.equal(final.attempt, 0)
    assert.equal(models, 0)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
  } finally { blocked = false; fs.renameSync = originalRename; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})

console.log(`team_queued_cancellation_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
