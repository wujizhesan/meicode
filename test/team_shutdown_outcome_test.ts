import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
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
  // 原来 2500ms 在 CI 负载下会偶发超时（Windows/Linux runner 上均出现过）。
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('团队关闭结果恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const closer of ['owner', 'peer'] as const) for (const maxAttempts of [1, 2]) {
  await check('真实失败待保存时 ' + closer + ' 关闭保留执行次数和上限 ' + maxAttempts, async () => {
    let models = 0, effects = 0, blocked = true
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++models === 1) throw new Error('REAL-COMPLETED-FAILURE')
      if (effects === 0) yield { type: 'tool_call', id: 'retry-write', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'RETRY-SUCCEEDED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(root, f.root, options), original = fs.renameSync, tasksFile = join(root, 'audit', 'tasks.json')
    let peer: TeamManager | undefined, fresh: TeamManager | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      f.registry.register({ name: 'write_file', description: '允许重试的真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(join(f.root, 'effects.log'), 'RETRY-EFFECT\n'); return { success: true, output: 'RETRY-EFFECT' }
      } })
      const task = team.addTask(group.name, 'REAL-FAILURE', 'alice', [], maxAttempts)
      fs.renameSync = ((source, destination) => {
        if (blocked && String(destination) === tasksFile && String(source).endsWith('.tmp')) {
          if (JSON.parse(fs.readFileSync(source, 'utf8')).some((item: { status: string }) => item.status !== 'in_progress')) {
            throw Object.assign(new Error('FAILED-RESULT-EIO'), { code: 'EIO' })
          }
        }
        return original(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      assert.match(await bounded(team.runTask(group, task, 'alice')), /待保存/)
      const entry = store.loadTaskSettlements(group.name)[0]
      assert.equal(entry.result?.status, 'failed')
      assert.notEqual(entry.requeueOnShutdown, true)
      if (closer === 'peer') { peer = new TeamManager(root, f.root, options); peer.listTasks(group.name); await bounded(peer.close(0)) }
      else await bounded(team.close(0))
      assert.notEqual(store.loadTaskSettlements(group.name)[0].requeueOnShutdown, true)
      blocked = false
      fresh = new TeamManager(root, f.root, options)
      const recovered = fresh.listTasks(group.name)[0]
      assert.equal(recovered.status, maxAttempts === 1 ? 'failed' : 'todo')
      assert.equal(recovered.attempt, 1)
      assert.equal(recovered.reportId, entry.reportId)
      assert.match(recovered.result!, /REAL-COMPLETED-FAILURE/)
      if (maxAttempts === 2) assert(recovered.nextRetryAt! > Date.now())
      await fresh.restore([])
      if (maxAttempts === 2) {
        await waitUntil(() => fresh!.listTasks(group.name)[0].status === 'done')
        assert.equal(fresh.listTasks(group.name)[0].attempt, 2)
        assert.equal(models, 3)
        assert.equal(effects, 1)
        assert.equal(fs.readFileSync(join(f.root, 'effects.log'), 'utf8'), 'RETRY-EFFECT\n')
      } else {
        assert.deepEqual(fresh.scheduleReadyTasks(group.name), [])
        assert.equal(models, 1)
        assert.equal(effects, 0)
        assert(!fs.existsSync(join(f.root, 'effects.log')))
      }
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally { blocked = false; fs.renameSync = original; syncBuiltinESMExports(); await peer?.close(1000); await fresh?.close(1000); await team.close(1000); await f.close() }
  })
}

for (const stage of ['subagent_stop', 'teammate_idle', 'history'] as const) {
  await check('真实失败在 ' + stage + ' 等待中关闭，保留原始错误和失败次数', async () => {
    const started = deferred(), gate = deferred(), hooks = new HookEngine([])
    let models = 0, blocked = true
    hooks.fire = async (event, payload) => { if (stage === event && payload.role === 'member:worker') { started.resolve(); await gate.promise } }
    // biome-ignore lint/correctness/useYield: 桩 provider 只负责抛错，不需要 yield（加了 yield 反而成为不可达代码）
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; throw new Error('REAL-FINISHED-ERROR') } }
    const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team'), store = new TeamGroupStore(root)
    const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const original = fs.appendFileSync, historyFile = join(root, 'audit', 'members', 'alice.history.jsonl')
    let execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'FINISHED-ERROR', 'alice', [], 1)
      fs.appendFileSync = ((file: unknown, ...args: unknown[]) => {
        if (blocked && stage === 'history' && String(file) === historyFile) {
          started.resolve(); throw Object.assign(new Error('FINISHED-HISTORY-EIO'), { code: 'EIO' })
        }
        return (original as (...args: unknown[]) => unknown)(file, ...args)
      }) as typeof fs.appendFileSync
      syncBuiltinESMExports()
      execution = team.runTask(group, task, 'alice')
      await bounded(started.promise)
      await bounded(team.close(1000))
      const response = await bounded(execution)
      assert.match(response, /REAL-FINISHED-ERROR/)
      const final = store.listTasks(group.name)[0]
      assert.equal(final.status, 'failed')
      assert.equal(final.attempt, 1)
      assert.equal(final.nextRetryAt, undefined)
      assert.match(final.lastError!, /REAL-FINISHED-ERROR/)
      assert.equal(models, 1)
      assert(!host.isBusy())
      assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_retry').length, 0)
      assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally { blocked = false; fs.appendFileSync = original; syncBuiltinESMExports(); gate.resolve(); await team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}

for (const stage of ['start', 'model', 'approval', 'tool'] as const) {
  await check('关闭确实中断 ' + stage + ' 执行时仍重新排队且不消耗次数', async () => {
    const started = deferred(), gate = deferred(), hooks = new HookEngine([])
    let models = 0, effects = 0
    hooks.fire = async (event, payload) => {
      if (stage === 'start' && event === 'subagent_start' && payload.role === 'member:worker') { started.resolve(); await gate.promise }
    }
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++
      if (stage === 'model') {
        started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined)
        if (options.signal?.aborted) return
      }
      yield { type: 'tool_call', id: 'held-write', name: 'write_file', arguments: {} }
    } }
    const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team'), store = new TeamGroupStore(root)
    const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null, needsApproval: stage === 'approval' })
      f.registry.register({ name: 'write_file', description: '中断前等待真实写入', parameters: { type: 'object' }, async execute(_args, ctx) {
        started.resolve(); await resolveOnAbort(gate.promise, ctx.signal, undefined)
        if (ctx.signal?.aborted) return { success: false, output: '', error: '已中断' }
        effects++; fs.appendFileSync(join(f.root, 'effects.log'), 'UNEXPECTED\n'); return { success: true, output: 'UNEXPECTED' }
      } })
      const task = team.addTask(group.name, 'INTERRUPTED', 'alice', [], 1)
      execution = team.runTask(group, task, 'alice')
      if (stage === 'approval') await waitUntil(() => team.readLeadMail().some((message) => message.kind === 'approval_plan'))
      else await bounded(started.promise)
      await bounded(team.close(1000)); await bounded(execution)
      gate.resolve()
      const final = store.listTasks(group.name)[0]
      assert.equal(final.status, 'todo')
      assert.equal(final.attempt, 0)
      assert.match(final.lastError!, /调度器关闭/)
      assert.equal(final.leaseId, undefined)
      assert.equal(models, stage === 'start' || stage === 'approval' ? 0 : 1)
      assert.equal(effects, 0)
      assert(!fs.existsSync(join(f.root, 'effects.log')))
      assert(!host.isBusy())
      assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_retry').length, 1)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally { gate.resolve(); await team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}

await check('启动前等待旧历史补存时关闭，新任务未调用模型且不消耗次数', async () => {
  const firstSave = deferred(), secondSave = deferred()
  let models = 0, blocked = true, second = false
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'PREVIOUS-COMPLETED' }; yield { type: 'done' } } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const original = fs.appendFileSync, historyFile = join(root, 'audit', 'members', 'alice.history.jsonl')
  let firstRun: Promise<string> | undefined, secondRun: Promise<string> | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const a = team.addTask(group.name, 'PREVIOUS'), b = team.addTask(group.name, 'CURRENT', undefined, [], 1)
    fs.appendFileSync = ((file: unknown, ...args: unknown[]) => {
      if (blocked && String(file) === historyFile) {
        if (second) secondSave.resolve(); else firstSave.resolve()
        throw Object.assign(new Error('PREVIOUS-HISTORY-EIO'), { code: 'EIO' })
      }
      return (original as (...args: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    firstRun = team.runTask(group, a, 'alice')
    await bounded(firstSave.promise)
    assert(host.cancel(a.id)); assert.match(await bounded(firstRun), /PREVIOUS-COMPLETED/)
    assert.equal(store.listTasks(group.name).find((task) => task.id === a.id)?.status, 'done')
    second = true
    secondRun = team.runTask(group, b, 'alice')
    await bounded(secondSave.promise)
    await bounded(team.close(1000)); await bounded(secondRun)
    const final = store.listTasks(group.name).find((task) => task.id === b.id)!
    assert.equal(final.status, 'todo')
    assert.equal(final.attempt, 0)
    assert.match(final.lastError!, /调度器关闭/)
    assert.equal(models, 1)
    assert(!host.isBusy())
    assert.equal(store.listTasks(group.name).find((task) => task.id === a.id)?.status, 'done')
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
  } finally { blocked = false; fs.appendFileSync = original; syncBuiltinESMExports(); await team.close(1000); await Promise.allSettled([firstRun, secondRun]); await f.close() }
})

await check('中断标记拒绝错误类型和成功结果，旧失败结果记录仍可读取', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), store = new TeamGroupStore(join(f.root, 'team'))
  try {
    store.createGroup('audit', 'lead')
    const entry = { kind: 'result' as const, groupName: 'audit', taskId: 'task', memberName: 'alice', leaseId: 'lease', reportId: 'report',
      result: { status: 'failed' as const, text: 'REAL-ERROR', report: { reportId: 'report', status: 'failed' as const, summary: 'REAL-ERROR' } } }
    assert.throws(() => store.saveTaskSettlement({ ...entry, result: { ...entry.result, interrupted: 'true' as never } }), /非法/)
    assert.throws(() => store.saveTaskSettlement({ ...entry, result: { status: 'done', text: 'DONE', interrupted: true, report: { reportId: 'report', status: 'done', summary: 'DONE' } } }), /非法/)
    store.saveTaskSettlement(entry)
    assert.deepEqual(store.loadTaskSettlements('audit'), [entry])
  } finally { await f.close() }
})

console.log(`team_shutdown_outcome_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
