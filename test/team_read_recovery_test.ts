import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'

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
    if (Date.now() >= end) throw new Error('团队读取故障恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const failure of ['tasks-stat', 'group-stat', 'group-read', 'group-corrupt'] as const) for (const recovery of ['timer', 'restart'] as const) {
  await check('结果读取 ' + failure + ' ' + recovery + ' 保留补存记录，真实写入和模型不重复执行', async () => {
    let blocked = false, models = 0, effects = 0, hooksRun = 0
    const hooks = new HookEngine([])
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++
      if (models % 2 === 1) yield { type: 'tool_call', id: 'effect-' + models, name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'ALREADY-COMPLETED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team')
    const store = new TeamGroupStore(root), options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(root, f.root, options)
    const originalStat = fs.statSync, originalRead = fs.readFileSync
    let fresh: TeamManager | undefined, originalGroup: string | undefined
    const groupFile = join(root, 'audit', 'group.yaml'), tasksFile = join(root, 'audit', 'tasks.json')
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      originalGroup = fs.readFileSync(groupFile, 'utf8')
      const effectsFile = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(effectsFile, 'EFFECT\n'); return { success: true, output: 'EFFECT' }
      } })
      hooks.fire = async (event, payload) => {
        if (event === 'subagent_stop' && payload.role === 'member:worker') {
          if (failure === 'group-read') fs.appendFileSync(groupFile, '\n# FORCE-RELOAD\n')
          if (failure === 'group-corrupt') fs.writeFileSync(groupFile, 'name: [BROKEN')
          blocked = true
        }
        if (event === 'task_completed') hooksRun++
      }
      fs.statSync = ((path, options) => {
        if (blocked && ((failure === 'tasks-stat' && String(path) === tasksFile) || (failure === 'group-stat' && String(path) === groupFile))) {
          throw Object.assign(new Error('READ-STAT-EACCES'), { code: 'EACCES' })
        }
        return originalStat(path, options)
      }) as typeof fs.statSync
      fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
        if (blocked && failure === 'group-read' && String(path) === groupFile) throw Object.assign(new Error('READ-FILE-EIO'), { code: 'EIO' })
        return (originalRead as (...args: unknown[]) => unknown)(path, ...args)
      }) as typeof fs.readFileSync
      syncBuiltinESMExports()
      const task = team.addTask(group.name, 'READ-RECOVERY', 'alice', [], 2)
      const response = await bounded(team.runTask(group, task, 'alice'))
      const pending = store.loadTaskSettlements(group.name)
      assert.equal(pending.length, 1)
      assert.match(response, /待保存/)
      assert.equal(pending[0].result?.text, 'ALREADY-COMPLETED')
      assert.equal(models, 2)
      assert.equal(effects, 1)
      assert.equal(hooksRun, 0)
      if (recovery === 'restart') {
        await bounded(team.close(0))
        fresh = new TeamManager(root, f.root, options)
        if (failure === 'tasks-stat') assert.throws(() => fresh!.listTasks(group.name), /READ-STAT-EACCES/)
        else {
          assert.equal(fresh.listTasks(group.name)[0].status, 'in_progress')
          assert.deepEqual(fresh.recoverStaleTasks(group.name, Number.MAX_SAFE_INTEGER), [])
        }
        assert.equal(store.loadTaskSettlements(group.name).length, 1)
      }
      blocked = false
      fs.statSync = originalStat; fs.readFileSync = originalRead; syncBuiltinESMExports()
      fs.writeFileSync(groupFile, originalGroup)
      if (fresh) {
        assert.equal(fresh.listTasks(group.name)[0].status, 'done')
        await fresh.restore([])
      } else await waitUntil(() => JSON.parse(fs.readFileSync(tasksFile, 'utf8'))[0].status === 'done')
      const final = store.listTasks(group.name)[0]
      assert.equal(final.status, 'done')
      assert.equal(final.result, 'ALREADY-COMPLETED')
      assert.equal(final.reportId, pending[0].reportId)
      assert.equal(final.attempt, 1)
      assert.equal(models, 2)
      assert.equal(effects, 1)
      assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'EFFECT\n')
      assert.equal(hooksRun, recovery === 'timer' ? 1 : 0)
      assert.equal((fresh ?? team).readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally {
      blocked = false; fs.statSync = originalStat; fs.readFileSync = originalRead; syncBuiltinESMExports()
      if (originalGroup) fs.writeFileSync(groupFile, originalGroup)
      await fresh?.close(1000); await team.close(1000); await f.close()
    }
  })
}

for (const failure of ['group-stat', 'group-read', 'group-corrupt'] as const) {
  await check('取消读取 ' + failure + ' 先停止模型，恢复后保存取消并通知正确负责人', async () => {
    const started = deferred(), gate = deferred()
    let blocked = false, models = 0, signal: AbortSignal | undefined
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++; signal = options.signal; started.resolve()
      await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return
      yield { type: 'text', text: 'UNEXPECTED' }; yield { type: 'done' }
    } }
    const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
    const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const mail = new TeamMail(join(root, '_shared', 'mail'))
    const originalStat = fs.statSync, originalRead = fs.readFileSync, groupFile = join(root, 'audit', 'group.yaml')
    let execution: Promise<string> | undefined, originalGroup: string | undefined
    try {
      const group = team.createGroup('audit', 'captain')
      mail.register(group.lead)
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      originalGroup = fs.readFileSync(groupFile, 'utf8')
      const task = team.addTask(group.name, 'CANCEL-READ', undefined, [], 2)
      execution = team.runTask(group, task, 'alice')
      await bounded(started.promise)
      if (failure === 'group-read') fs.appendFileSync(groupFile, '\n# FORCE-RELOAD\n')
      if (failure === 'group-corrupt') fs.writeFileSync(groupFile, 'name: [BROKEN')
      blocked = true
      fs.statSync = ((path, options) => {
        if (blocked && failure === 'group-stat' && String(path) === groupFile) throw Object.assign(new Error('CANCEL-GROUP-STAT-EACCES'), { code: 'EACCES' })
        return originalStat(path, options)
      }) as typeof fs.statSync
      fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
        if (blocked && failure === 'group-read' && String(path) === groupFile) throw Object.assign(new Error('CANCEL-GROUP-READ-EIO'), { code: 'EIO' })
        return (originalRead as (...args: unknown[]) => unknown)(path, ...args)
      }) as typeof fs.readFileSync
      syncBuiltinESMExports()
      assert(team.cancelTask(group.name, task.id))
      assert.equal(signal?.aborted, true)
      await bounded(execution)
      assert.equal(store.listTasks(group.name)[0].status, 'in_progress')
      assert.equal(store.loadTaskSettlements(group.name).filter((entry) => entry.kind === 'cancel').length, 1)
      assert.deepEqual(mail.read(group.lead), [])
      assert.deepEqual(mail.read('lead'), [])
      blocked = false; fs.statSync = originalStat; fs.readFileSync = originalRead; syncBuiltinESMExports()
      fs.writeFileSync(groupFile, originalGroup)
      await waitUntil(() => team.listTasks(group.name)[0].status === 'cancelled')
      assert.equal(models, 1)
      assert.equal(store.listTasks(group.name)[0].attempt, 1)
      assert.equal(mail.read(group.lead).filter((message) => message.kind === 'task_cancelled').length, 1)
      assert.deepEqual(mail.read('lead'), [])
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally {
      blocked = false; fs.statSync = originalStat; fs.readFileSync = originalRead; syncBuiltinESMExports()
      if (originalGroup) fs.writeFileSync(groupFile, originalGroup)
      gate.resolve(); await team.close(1000); await Promise.allSettled([execution]); await f.close()
    }
  })
}

for (const failure of ['root-stat', 'group-stat'] as const) {
  await check('团队列表 ' + failure + ' 错误显式返回，恢复后不会缓存缺失的小组', async () => {
    const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
    const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
    const originalStat = fs.statSync
    try {
      store.createGroup('first', 'lead'); store.createGroup('second', 'lead')
      fs.writeFileSync(join(root, 'plain-file'), 'PLAIN')
      const reader = new TeamGroupStore(root), target = failure === 'root-stat' ? root : join(root, 'second', 'group.yaml')
      fs.statSync = ((path, options) => {
        if (String(path) === target) throw Object.assign(new Error('GROUP-LIST-EACCES'), { code: 'EACCES' })
        return originalStat(path, options)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
      assert.throws(() => reader.listGroups(), /GROUP-LIST-EACCES/)
      fs.statSync = originalStat; syncBuiltinESMExports()
      assert.deepEqual(reader.listGroups().sort(), ['first', 'second'])
      assert.deepEqual(reader.listGroups().sort(), ['first', 'second'])
    } finally { fs.statSync = originalStat; syncBuiltinESMExports(); await f.close() }
  })
}

await check('不存在的文件仍返回空值，普通损坏查询保持兼容，严格补存读取保留错误', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  try {
    assert.deepEqual(store.listGroups(), [])
    assert.equal(store.loadGroup('missing'), null)
    assert.equal(store.loadGroup('missing', { strict: true }), null)
    assert.deepEqual(store.listTasks('missing'), [])
    store.createGroup('broken', 'lead')
    fs.writeFileSync(join(root, 'broken', 'group.yaml'), 'name: [BROKEN')
    assert.equal(store.loadGroup('broken'), null)
    assert.throws(() => store.loadGroup('broken', { strict: true }), /小组文件损坏/)
    fs.writeFileSync(join(root, 'broken', 'group.yaml'), 'name: broken\nlead: lead\nmembers: []\n')
    assert.equal(store.loadGroup('broken', { strict: true })?.name, 'broken')
  } finally { await f.close() }
})

console.log(`team_read_recovery_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
