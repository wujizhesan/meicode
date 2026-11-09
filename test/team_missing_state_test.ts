import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
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
  const deadline = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('缺失状态恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}
async function fixture(blockModel = false) {
  let models = 0, effects = 0, signal: AbortSignal | undefined
  const started = deferred(), gate = deferred(), hooks = new HookEngine([])
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; signal = options.signal
    if (blockModel) {
      started.resolve()
      await resolveOnAbort(gate.promise, options.signal, undefined)
      if (options.signal?.aborted) return
    }
    if (models % 2 === 1) yield { type: 'tool_call', id: 'effect-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'SAVED-WORK' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team')
  const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
  const store = new TeamGroupStore(root), team = new TeamManager(root, f.root, options)
  const group = team.createGroup('audit', 'captain'), mail = new TeamMail(join(root, '_shared', 'mail'))
  mail.register('captain'); mail.register('lead')
  await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
  const effectsFile = join(f.root, 'effects.log'), groupFile = join(root, 'audit', 'group.yaml'), tasksFile = join(root, 'audit', 'tasks.json')
  f.registry.register({ name: 'write_file', description: '缺失状态回归真实写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(effectsFile, 'EFFECT\n'); return { success: true, output: 'SAVED' }
  } })
  const held = new Map<string, string>()
  const hide = (kind: 'group' | 'tasks') => {
    const file = kind === 'group' ? groupFile : tasksFile, backup = file + '.held'
    fs.renameSync(file, backup); held.set(file, backup)
  }
  const restore = () => { for (const [file, backup] of held) fs.renameSync(backup, file); held.clear() }
  return { ...f, root, options, team, store, group, mail, hooks, started, gate, hide, restore, effectsFile, groupFile, tasksFile,
    get models() { return models }, get effects() { return effects }, get signal() { return signal },
    async close() { restore(); gate.resolve(); await team.close(1000); await f.close() },
  }
}

for (const missing of ['group', 'tasks'] as const) for (const recovery of ['timer', 'restart'] as const) {
  await check(`完成结果 ${missing} 缺失 ${recovery} 保留日志，恢复只补存且不重复写入`, async () => {
    const f = await fixture()
    let fresh: TeamManager | undefined
    let completionHooks = 0
    try {
      f.hooks.fire = async (event, payload) => {
        if (event === 'subagent_stop' && payload.role === 'member:worker') f.hide(missing)
        if (event === 'task_completed') {
          completionHooks++
          const saved = JSON.parse(fs.readFileSync(f.tasksFile, 'utf8'))[0]
          assert.equal(saved.status, 'done'); assert.equal(saved.result, 'SAVED-WORK')
          f.gate.resolve()
        }
      }
      const task = f.team.addTask('audit', 'MISSING-RESULT', 'alice', [], 2)
      const response = await bounded(f.team.runTask(f.group, task, 'alice'))
      assert.match(response, /待保存/)
      const pending = f.store.loadTaskSettlements('audit')
      assert.equal(pending.length, 1); assert.equal(pending[0].result?.text, 'SAVED-WORK')
      assert.equal(f.models, 2); assert.equal(f.effects, 1)
      assert.equal(completionHooks, 0)
      assert.deepEqual(f.mail.read('captain'), []); assert.deepEqual(f.mail.read('lead'), [])
      if (recovery === 'restart') {
        await bounded(f.team.close(0))
        fresh = new TeamManager(f.root, f.root, f.options)
        fresh.listTasks('audit')
        assert.equal(f.store.loadTaskSettlements('audit').length, 1)
      } else {
        f.team.listTasks('audit')
        assert.equal(f.store.loadTaskSettlements('audit').length, 1)
      }
      f.restore()
      const target = fresh ?? f.team
      if (fresh) { target.listTasks('audit'); await target.restore([]) }
      else { await bounded(f.gate.promise); await waitUntil(() => f.store.listTasks('audit')[0].status === 'done') }
      const saved = f.store.listTasks('audit')[0]
      assert.equal(saved.status, 'done'); assert.equal(saved.result, 'SAVED-WORK'); assert.equal(saved.attempt, 1)
      assert.equal(saved.reportId, pending[0].reportId); assert.equal(saved.nextRetryAt, undefined)
      target.listTasks('audit')
      assert.deepEqual(target.scheduleReadyTasks('audit'), [])
      assert.equal(f.models, 2); assert.equal(f.effects, 1)
      assert.equal(completionHooks, recovery === 'timer' ? 1 : 0)
      assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'EFFECT\n')
      assert.equal(f.mail.read('captain').filter((message) => message.kind === 'task_result').length, 1)
      assert.deepEqual(f.mail.read('lead'), []); assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    } finally { f.restore(); await fresh?.close(1000); await f.close() }
  })
}
for (const missing of ['group', 'tasks'] as const) for (const recovery of ['timer', 'restart'] as const) {
  await check(`运行取消 ${missing} 缺失 ${recovery} 立即停止模型，恢复通知正确负责人`, async () => {
    const f = await fixture(true)
    let fresh: TeamManager | undefined, execution: Promise<string> | undefined
    try {
      const task = f.team.addTask('audit', 'MISSING-CANCEL', 'alice', [], 2)
      execution = f.team.runTask(f.group, task, 'alice')
      await bounded(f.started.promise)
      f.hide(missing)
      assert(f.team.cancelTask('audit', task.id))
      assert.equal(f.signal?.aborted, true)
      await bounded(execution)
      const pending = f.store.loadTaskSettlements('audit').filter((entry) => entry.kind === 'cancel')
      assert.equal(pending.length, 1)
      assert.equal(f.models, 1); assert.equal(f.effects, 0)
      assert.deepEqual(f.mail.read('captain'), []); assert.deepEqual(f.mail.read('lead'), [])
      if (recovery === 'restart') {
        await bounded(f.team.close(0))
        fresh = new TeamManager(f.root, f.root, f.options)
        fresh.listTasks('audit')
        assert.equal(f.store.loadTaskSettlements('audit').filter((entry) => entry.kind === 'cancel').length, 1)
      }
      f.restore()
      const target = fresh ?? f.team
      if (fresh) { target.listTasks('audit'); await target.restore([]) }
      else await waitUntil(() => JSON.parse(fs.readFileSync(f.tasksFile, 'utf8'))[0].status === 'cancelled')
      const saved = target.listTasks('audit')[0]
      assert.equal(saved.status, 'cancelled'); assert.equal(saved.reportId, pending[0].reportId)
      assert.equal(saved.attempt, 1); assert.equal(saved.leaseId, undefined); assert.equal(saved.nextRetryAt, undefined)
      assert.equal(f.models, 1); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
      assert.deepEqual(target.scheduleReadyTasks('audit'), [])
      assert.equal(f.mail.read('captain').filter((message) => message.kind === 'task_cancelled').length, 1)
      assert.deepEqual(f.mail.read('lead'), []); assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    } finally { f.restore(); f.gate.resolve(); await fresh?.close(1000); await f.team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}
for (const missing of ['group', 'tasks'] as const) for (const status of ['done', 'cancelled'] as const) {
  await check(`补存 ${status} 锁内 ${missing} 文件消失时保留日志，恢复后继续保存`, async () => {
    const f = await fixture(status === 'cancelled')
    let execution: Promise<string> | undefined
    const originalRename = fs.renameSync, originalStat = fs.statSync
    let armed = false, injected = false, reads = 0
    try {
      const task = f.team.addTask('audit', 'LOCKED-MISSING', 'alice', [], 2)
      fs.renameSync = ((source, destination) => {
        if (String(destination).includes('tasks.pending') && String(destination).endsWith('.json')) armed = true
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      fs.statSync = ((path, options) => {
        if (armed && !injected && String(path) === f.tasksFile && ++reads === (status === 'done' ? 2 : 1)) {
          injected = true; f.hide(missing)
        }
        return originalStat(path, options)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
      if (status === 'cancelled') {
        execution = f.team.runTask(f.group, task, 'alice'); await bounded(f.started.promise)
        assert(f.team.cancelTask('audit', task.id)); await bounded(execution)
      } else await bounded(f.team.runTask(f.group, task, 'alice'))
      assert(injected)
      assert(!fs.existsSync(missing === 'tasks' ? f.tasksFile : f.groupFile))
      assert(f.store.loadTaskSettlements('audit').some((entry) => entry.kind === (status === 'done' ? 'result' : 'cancel')))
      fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports()
      f.restore()
      await waitUntil(() => f.team.listTasks('audit')[0].status === status)
      assert.equal(f.models, status === 'done' ? 2 : 1); assert.equal(f.effects, status === 'done' ? 1 : 0)
      assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    } finally { fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports(); f.restore(); f.gate.resolve(); await f.team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}
await check('缺失查询保持兼容，明确移除的任务仍清理过期日志', async () => {
  const f = await fixture()
  try {
    assert.equal(f.store.loadGroup('absent'), null); assert.deepEqual(f.store.listTasks('absent'), [])
    assert.equal(f.team.cancelTask('absent', 'unknown'), false)
    f.hide('tasks')
    assert.deepEqual(f.store.listTasks('audit'), [])
    assert.throws(() => f.team.cancelTask('audit', 'unknown'), /ENOENT/)
    assert(!fs.existsSync(f.tasksFile))
    f.restore()
    f.store.saveTaskSettlement({ kind: 'result', groupName: 'audit', taskId: 'removed-task', memberName: 'alice',
      leaseId: 'removed-lease', reportId: 'removed-report', result: { status: 'done', text: 'OLD-RESULT',
        report: { reportId: 'removed-report', status: 'done', summary: 'OLD-RESULT' } } })
    assert.deepEqual(f.team.listTasks('audit'), [])
    assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.deepEqual(f.mail.read('captain'), []); assert.deepEqual(f.mail.read('lead'), [])
  } finally { await f.close() }
})
console.log(`缺失状态补存: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
