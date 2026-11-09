import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import type { TeamTaskSettlement } from '../src/team/types.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('任务执行租约验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
type Change = 'lease' | 'cancel' | 'done' | 'requeue' | 'expired'
async function fixture(stage: 'start' | 'pre-tool' | 'round' | 'final-text' | 'final-result' | 'none', change: Change = 'lease') {
  let models = 0, effects = 0, changed = false
  let signal: AbortSignal | undefined, cancellation: TeamTaskSettlement | undefined
  const hooks = new HookEngine([])
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; signal = options.signal
    if (stage === 'final-text' || (stage === 'final-result' && models === 2)) {
      replace(); yield { type: 'text', text: 'STALE-FINAL' }; yield { type: 'done' }; return
    }
    if (models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'VALID-LEASE-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const ctx = { ...f.chat.getToolContext(), agentId: 'lead-agent' }
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx })
  const group = team.createGroup('audit', 'captain')
  const host = await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
  const mail = new TeamMail(join(root, '_shared', 'mail')); mail.register('captain')
  const scheduler = new TeamTaskScheduler({ store, mail, members: new Map([['alice', host]]), memberGroups: new Map([['alice', 'audit']]),
    ctx, leaseMs: 60000, leaseHeartbeatMs: 30000 })
  const effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '租约边界真实写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(effectsFile, 'EFFECT\n'); return { success: true, output: 'EFFECT' }
  } })
  const task = scheduler.addTask('audit', 'EXECUTION-LEASE', 'alice')
  function cancelEntry(): TeamTaskSettlement {
    const current = store.listTasks('audit')[0]
    return { kind: 'cancel', groupName: 'audit', taskId: current.id, memberName: 'alice', leaseId: current.leaseId,
      agentId: current.activeAgentId, reportId: 'current-cancel' }
  }
  function replace() {
    if (changed) return
    changed = true
    if (change === 'cancel') { cancellation = cancelEntry(); store.saveTaskSettlement(cancellation); return }
    store.mutateTasks('audit', (tasks) => {
      const current = tasks[0]
      if (change === 'lease') { current.leaseId = 'successor-lease'; current.activeAgentId = 'successor-agent'; current.result = 'SUCCESSOR' }
      if (change === 'done') { current.status = 'done'; current.leaseId = undefined; current.result = 'SUCCESSOR' }
      if (change === 'requeue') { current.status = 'todo'; current.assignee = undefined; current.leaseId = undefined; current.result = 'SUCCESSOR' }
      if (change === 'expired') current.leaseExpiresAt = 0
    })
  }
  hooks.fire = async (event, payload, currentSignal) => {
    if (stage === 'start' && event === 'subagent_start') { signal = currentSignal; replace() }
    if (stage === 'round' && event === 'round_start' && payload.round === 2) replace()
  }
  hooks.intercept = async () => { if (stage === 'pre-tool') replace(); return null }
  return { ...f, root, team, store, group, host, mail, scheduler, task, hooks, effectsFile, replace, cancelEntry,
    get models() { return models }, get effects() { return effects }, get changed() { return changed }, get signal() { return signal },
    get cancellation() { return cancellation },
    async run() { return bounded(scheduler.runTask(group, task, 'alice')) },
    async close() { await scheduler.close(1000); await team.close(1000); await f.close() },
  }
}
for (const stage of ['start', 'pre-tool', 'round', 'final-text', 'final-result'] as const) for (const change of ['lease', 'cancel'] as const) {
  await check(`${stage} 出现 ${change} 不等心跳便阻止旧写入和成功结果`, async () => {
    const f = await fixture(stage, change)
    try {
      const result = await f.run()
      assert(f.changed)
      const hadEffect = stage === 'round' || stage === 'final-result'
      assert.equal(f.effects, hadEffect ? 1 : 0)
      assert.equal(f.models, stage === 'start' ? 0 : stage === 'final-result' ? 2 : 1)
      assert.equal(f.signal?.aborted, true)
      assert.match(result, /取消|失败/)
      const current = f.store.listTasks('audit')[0]
      assert.equal(current.attempt, 1)
      if (change === 'lease') {
        assert.equal(current.status, 'in_progress'); assert.equal(current.leaseId, 'successor-lease')
        assert.equal(current.activeAgentId, 'successor-agent'); assert.equal(current.result, 'SUCCESSOR')
        assert.deepEqual(f.mail.read('captain'), [])
      } else {
        assert.equal(current.status, 'cancelled'); assert.equal(current.reportId, f.cancellation?.reportId)
        assert.equal(f.mail.read('captain').filter((message) => message.kind === 'task_cancelled').length, 1)
      }
      assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
      if (hadEffect) assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'EFFECT\n')
      else assert(!fs.existsSync(f.effectsFile))
    } finally { await f.close() }
  })
}
for (const change of ['done', 'requeue', 'expired'] as const) {
  await check(`工具执行前任务 ${change} 阻止真实写入并保持新状态`, async () => {
    const f = await fixture('pre-tool', change)
    try {
      await f.run()
      assert(f.changed); assert.equal(f.models, 1); assert.equal(f.effects, 0); assert.equal(f.signal?.aborted, true)
      assert(!fs.existsSync(f.effectsFile))
      const current = f.store.listTasks('audit')[0]
      assert.equal(current.attempt, 1)
      if (change === 'expired') { assert.equal(current.status, 'failed'); assert.notEqual(current.result, 'VALID-LEASE-DONE') }
      else { assert.equal(current.status, change === 'done' ? 'done' : 'todo'); assert.equal(current.result, 'SUCCESSOR') }
    } finally { await f.close() }
  })
}
for (const field of ['taskId', 'leaseId', 'agentId', 'memberName'] as const) {
  await check(`其他 ${field} 的取消日志不阻止正常执行`, async () => {
    const f = await fixture('none')
    try {
      let injected = false
      f.hooks.intercept = async () => {
        if (!injected) { injected = true; const entry = f.cancelEntry(); entry[field] = 'other-identity'; f.store.saveTaskSettlement(entry) }
        return null
      }
      assert.match(await f.run(), /VALID-LEASE-DONE/)
      assert(injected); assert.equal(f.models, 2); assert.equal(f.effects, 1)
      assert.equal(f.store.listTasks('audit')[0].status, 'done')
      assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'EFFECT\n')
      assert.equal(f.mail.read('captain').filter((message) => message.kind === 'task_result').length, 1)
      assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    } finally { await f.close() }
  })
}
for (const file of ['tasks', 'settlements'] as const) {
  await check(`即时 ${file} 读取故障期间等待，恢复后正常执行一次`, async () => {
    const f = await fixture('none'), originalStat = fs.statSync, started = deferred()
    let blocked = false, reads = 0, execution: Promise<string> | undefined
    const target = join(f.root, 'audit', file === 'tasks' ? 'tasks.json' : 'tasks.pending')
    try {
      f.hooks.intercept = async () => { blocked = true; started.resolve(); return null }
      fs.statSync = ((path, options) => {
        if (blocked && String(path) === target) { reads++; throw Object.assign(new Error('CURRENT-LEASE-READ-EACCES'), { code: 'EACCES' }) }
        return originalStat(path, options)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
      execution = f.run(); await bounded(started.promise)
      await waitUntil(() => reads > 0)
      assert.equal(f.models, 1); assert.equal(f.effects, 0); assert.equal(f.signal?.aborted, false)
      assert(!fs.existsSync(f.effectsFile))
      blocked = false
      assert.match(await bounded(execution), /VALID-LEASE-DONE/)
      assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.store.listTasks('audit')[0].status, 'done')
      assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'EFFECT\n')
    } finally { blocked = false; fs.statSync = originalStat; syncBuiltinESMExports(); await f.close(); await Promise.allSettled([execution]) }
  })
}
await check('当前租约的无关任务元数据更新不阻止正常执行', async () => {
  const f = await fixture('none')
  try {
    f.hooks.intercept = async () => {
      f.store.updateTask('audit', f.task.id, { title: 'UPDATED-TITLE', updatedAt: Date.now() + 1000, leaseExpiresAt: Date.now() + 60000 })
      return null
    }
    assert.match(await f.run(), /VALID-LEASE-DONE/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.store.listTasks('audit')[0].status, 'done')
  } finally { await f.close() }
})
console.log(`执行即时租约: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
