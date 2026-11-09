import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function fixture(provider: Provider, options: { hooks?: HookEngine; needsApproval?: boolean } = {}) {
  const f = await streamFixture(provider, options)
  const root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const created = team.createGroup('lease', 'lead')
  const host = await team.spawnMember(created, 'alice', 'worker', { workdir: f.root, roleDefinition: null, needsApproval: options.needsApproval })
  const group = store.loadGroup(created.name)!
  const mail = new TeamMail(join(root, '_shared', 'mail'))
  const scheduler = new TeamTaskScheduler({
    store, mail, members: new Map([['alice', host]]), memberGroups: new Map([['alice', group.name]]),
    ctx: f.chat.getToolContext(), leaseMs: 3000, leaseHeartbeatMs: 20,
  })
  return { ...f, store, team, group, host, mail, scheduler,
    async close() { await scheduler.close(0); await team.close(1000); await f.close() },
  }
}
const heartbeat = () => new Promise<void>((done) => setTimeout(done, 80))
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('等待租约失效取消超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}

for (const mode of ['newlease', 'deleted', 'done', 'assignee', 'agent'] as const) {
  await check('租约失效 ' + mode + ' 停止旧模型、阻止真实文件写入且不覆盖新状态', async () => {
    const started = deferred(), gate = deferred()
    let signal: AbortSignal | undefined, models = 0, effects = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++
      if (models === 1) {
        signal = options.signal; started.resolve()
        await resolveOnAbort(gate.promise, signal, undefined)
        if (signal?.aborted) return
        yield { type: 'tool_call', id: 'stale-write', name: 'write_file', arguments: {} }
      } else { yield { type: 'text', text: 'STALE-RESULT' }; yield { type: 'done' } }
    } }
    const f = await fixture(provider)
    let execution: Promise<string> | undefined
    try {
      const file = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
        effects++; appendFileSync(file, 'STALE-EFFECT\n'); return { success: true, output: 'STALE-EFFECT' }
      } })
      const task = f.scheduler.addTask(f.group.name, 'LEASE-OLD')
      execution = f.scheduler.runTask(f.group, task, 'alice')
      await bounded(started.promise)
      f.store.mutateTasks(f.group.name, (tasks) => {
        const current = tasks[0]
        if (mode === 'deleted') tasks.splice(0, 1)
        else if (mode === 'done') { current.status = 'done'; current.result = 'SUCCESSOR'; current.leaseId = undefined }
        else if (mode === 'assignee') current.assignee = 'successor'
        else if (mode === 'agent') current.activeAgentId = 'successor-agent'
        else { current.leaseId = 'successor-lease'; current.activeAgentId = 'successor-agent'; current.leaseExpiresAt = Date.now() + 10000 }
      })
      const successor = f.store.listTasks(f.group.name)
      await heartbeat()
      gate.resolve(); await bounded(execution)
      assert.equal(effects, 0, '失去租约的旧执行者产生了实际写入')
      assert.equal(signal?.aborted, true)
      assert.equal(models, 1)
      assert(!existsSync(file))
      assert(!f.host.isBusy())
      assert.deepEqual(f.store.listTasks(f.group.name), successor)
      assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
      assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
    } finally { gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
  })
}

for (const stage of ['start', 'approval', 'tool'] as const) {
  await check('租约失效中断 ' + stage + ' 等待，迟到审批或工具不能继续执行', async () => {
    const started = deferred(), gate = deferred(), hooks = new HookEngine([])
    let signal: AbortSignal | undefined, models = 0, effects = 0
    hooks.fire = async (event, _payload, currentSignal) => {
      if (stage === 'start' && event === 'subagent_start') { signal = currentSignal; started.resolve(); await gate.promise }
    }
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++
      if (models === 1) yield { type: 'tool_call', id: 'held-write', name: 'write_file', arguments: {} }
      else yield { type: 'done' }
    } }
    const f = await fixture(provider, { hooks, needsApproval: stage === 'approval' })
    let execution: Promise<string> | undefined
    try {
      const file = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '等待后真实写入', parameters: { type: 'object' }, async execute(_args, ctx) {
        signal = ctx.signal; started.resolve()
        await resolveOnAbort(gate.promise, signal, undefined)
        if (signal?.aborted) return { success: false, output: '', error: '已取消' }
        effects++; appendFileSync(file, 'LATE-EFFECT\n'); return { success: true, output: 'LATE-EFFECT' }
      } })
      const task = f.scheduler.addTask(f.group.name, 'LEASE-WAIT')
      execution = f.scheduler.runTask(f.group, task, 'alice')
      if (stage === 'approval') await waitUntil(() => f.team.readLeadMail().some((message) => message.kind === 'approval_plan'))
      else await bounded(started.promise)
      f.store.mutateTasks(f.group.name, (tasks) => { tasks[0].leaseId = 'successor-lease'; tasks[0].activeAgentId = 'successor-agent' })
      const successor = f.store.listTasks(f.group.name)
      await bounded(execution)
      if (stage === 'approval') {
        const plan = f.team.readLeadMail().find((message) => message.kind === 'approval_plan')!
        f.mail.send('lead', 'alice', 'APPROVE', { groupId: f.group.name, kind: 'approval_decision', taskId: task.id, correlationId: plan.correlationId })
      } else assert.equal(signal?.aborted, true)
      gate.resolve(); await heartbeat()
      assert.equal(models, stage === 'tool' ? 1 : 0)
      assert.equal(effects, 0)
      assert(!existsSync(file))
      assert(!f.host.isBusy())
      assert.deepEqual(f.store.listTasks(f.group.name), successor)
      assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
    } finally { gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
  })
}

await check('短暂心跳读写故障继续执行并续期，正常任务结果只保存一次', async () => {
  const started = deferred(), gate = deferred(), fault = deferred(), renewed = deferred()
  let signal: AbortSignal | undefined, models = 0, effects = 0, failures = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (models === 1) {
      signal = options.signal; started.resolve()
      await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return
      yield { type: 'tool_call', id: 'normal-write', name: 'write_file', arguments: {} }
    } else { yield { type: 'text', text: 'NORMAL-RESULT' }; yield { type: 'done' } }
  } }
  const f = await fixture(provider), original = f.store.mutateTasks.bind(f.store)
  let execution: Promise<string> | undefined
  try {
    f.registry.register({ name: 'write_file', description: '正常真实写入', parameters: { type: 'object' }, async execute() {
      effects++; appendFileSync(join(f.root, 'effects.log'), 'NORMAL-EFFECT\n'); return { success: true, output: 'NORMAL-EFFECT' }
    } })
    const task = f.scheduler.addTask(f.group.name, 'LEASE-NORMAL')
    execution = f.scheduler.runTask(f.group, task, 'alice')
    await bounded(started.promise)
    const expiry = f.store.listTasks(f.group.name)[0].leaseExpiresAt!
    f.store.mutateTasks = ((groupName, mutator) => {
      if (failures++ === 0) { fault.resolve(); throw Object.assign(new Error('HEARTBEAT-EIO'), { code: 'EIO' }) }
      const tasks = original(groupName, mutator)
      renewed.resolve(); return tasks
    }) as TeamGroupStore['mutateTasks']
    await bounded(fault.promise); await bounded(renewed.promise)
    f.store.mutateTasks = original
    assert.equal(signal?.aborted, false)
    assert(f.store.listTasks(f.group.name)[0].leaseExpiresAt! > expiry)
    gate.resolve(); await bounded(execution)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done')
    assert.equal(f.store.listTasks(f.group.name)[0].result, 'NORMAL-RESULT')
    assert.equal(effects, 1)
    assert.equal(models, 2)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
  } finally { f.store.mutateTasks = original; gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
})

await check('已取消的领取信号在启动前生效，不触发 Hook、模型或工具', async () => {
  let models = 0, hooksRun = 0
  const hooks = new HookEngine([])
  hooks.fire = async () => { hooksRun++ }
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
  const f = await fixture(provider, { hooks }), controller = new AbortController()
  try {
    controller.abort()
    const result = await bounded(f.host.execute('PRE-CANCELLED', 'cancelled', controller.signal))
    assert.equal(result.status, 'failed')
    assert.match(result.text, /取消/)
    assert.equal(models, 0)
    assert.equal(hooksRun, 0)
    assert(!f.host.isBusy())
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  } finally { await f.close() }
})

await check('旧执行完成后清理信号监听，同任务新租约不会被旧心跳取消', async () => {
  const returned = deferred(), oldGate = deferred(), newStarted = deferred(), newGate = deferred()
  let oldSignal: AbortSignal | undefined, newSignal: AbortSignal | undefined, models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (models === 2) {
      newSignal = options.signal; newStarted.resolve()
      await resolveOnAbort(newGate.promise, newSignal, undefined)
      if (newSignal?.aborted) return
    }
    yield { type: 'text', text: models === 1 ? 'OLD-RESULT' : 'NEW-RESULT' }; yield { type: 'done' }
  } }
  const f = await fixture(provider), original = f.host.execute.bind(f.host)
  let oldRun: Promise<string> | undefined, newRun: Promise<string> | undefined
  try {
    let executions = 0
    f.host.execute = async (title, taskId, signal) => {
      const first = ++executions === 1
      if (first) oldSignal = signal
      const result = await original(title, taskId, signal)
      if (first) { returned.resolve(); await oldGate.promise }
      return result
    }
    const task = f.scheduler.addTask(f.group.name, 'LEASE-HANDOFF', undefined, [], 2)
    oldRun = f.scheduler.runTask(f.group, task, 'alice')
    await bounded(returned.promise)
    assert(!f.host.isBusy())
    assert(oldSignal)
    assert.equal(getEventListeners(oldSignal, 'abort').length, 0)
    f.store.mutateTasks(f.group.name, (tasks) => { tasks[0].status = 'todo'; tasks[0].leaseId = undefined; tasks[0].activeAgentId = undefined; tasks[0].leaseExpiresAt = undefined })
    newRun = f.scheduler.runTask(f.group, task, 'alice')
    await bounded(newStarted.promise)
    const lease = f.store.listTasks(f.group.name)[0].leaseId
    await heartbeat()
    assert.equal(oldSignal.aborted, true)
    assert.equal(newSignal?.aborted, false)
    assert(f.host.isBusy())
    oldGate.resolve(); await bounded(oldRun)
    assert.equal(f.store.listTasks(f.group.name)[0].leaseId, lease)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'in_progress')
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
    newGate.resolve(); await bounded(newRun)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done')
    assert.equal(f.store.listTasks(f.group.name)[0].result, 'NEW-RESULT')
    assert.equal(models, 2)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
  } finally { oldGate.resolve(); newGate.resolve(); await f.close(); await Promise.allSettled([oldRun, newRun]) }
})

console.log(`team_lease_cancellation_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
