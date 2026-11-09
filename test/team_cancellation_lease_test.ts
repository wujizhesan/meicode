import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
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
for (const mode of ['running', 'running-read', 'running-write', 'queued', 'done'] as const) {
  await check('旧领取尚未结算时取消 ' + mode + ' 正确匹配当前任务版本', async () => {
    const returned = deferred(), oldGate = deferred(), newStarted = deferred(), newGate = deferred()
    let models = 0, effects = 0, blocked = false, newSignal: AbortSignal | undefined
    const running = mode.startsWith('running')
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++
      if (models === 1) { yield { type: 'text', text: 'OLD-RESULT' }; yield { type: 'done' }; return }
      newSignal = options.signal; newStarted.resolve()
      await resolveOnAbort(newGate.promise, newSignal, undefined)
      if (newSignal?.aborted) return
      yield { type: 'tool_call', id: 'new-write', name: 'write_file', arguments: {} }
    } }
    const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
    const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const originalStat = fs.statSync, originalRename = fs.renameSync, tasksFile = join(root, 'audit', 'tasks.json')
    let oldRun: Promise<string> | undefined, newRun: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(join(f.root, 'effects.log'), 'EFFECT\n'); return { success: true, output: 'EFFECT' }
      } })
      const original = host.execute.bind(host)
      let executions = 0
      host.execute = async (title, taskId, signal) => {
        const first = ++executions === 1, result = await original(title, taskId, signal)
        if (first) { returned.resolve(); await oldGate.promise }
        return result
      }
      const task = team.addTask(group.name, 'LEASE-CANCEL', undefined, [], 2)
      oldRun = team.runTask(group, task, 'alice')
      await bounded(returned.promise)
      assert(!host.isBusy())
      store.mutateTasks(group.name, (tasks) => {
        tasks[0].status = mode === 'done' ? 'done' : 'todo'
        tasks[0].leaseId = undefined; tasks[0].activeAgentId = undefined; tasks[0].leaseExpiresAt = undefined
        tasks[0].result = mode === 'done' ? 'SUCCESSOR-RESULT' : undefined
      })
      if (running) {
        team.setSessionId('current-session')
        newRun = team.runTask(group, task, 'alice')
        await bounded(newStarted.promise)
      }
      const before = store.listTasks(group.name)[0]
      fs.statSync = ((path, options) => {
        if (blocked && mode === 'running-read' && String(path) === tasksFile) throw Object.assign(new Error('CURRENT-LEASE-READ-EACCES'), { code: 'EACCES' })
        return originalStat(path, options)
      }) as typeof fs.statSync
      fs.renameSync = ((source, destination) => {
        if (blocked && mode === 'running-write' && String(destination) === tasksFile && String(source).endsWith('.tmp')) {
          if (JSON.parse(fs.readFileSync(source, 'utf8')).some((item: { status: string }) => item.status === 'cancelled')) {
            throw Object.assign(new Error('CURRENT-LEASE-WRITE-EIO'), { code: 'EIO' })
          }
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports(); blocked = true
      assert.equal(team.cancelTask(group.name, task.id), mode !== 'done')
      if (running) { assert.equal(newSignal?.aborted, true); await bounded(newRun!) }
      let reportId: string | undefined
      if (mode === 'running-read' || mode === 'running-write') {
        const request = store.loadTaskSettlements(group.name).find((entry) => entry.kind === 'cancel')!
        assert(request)
        assert.equal(request.leaseId, before.leaseId)
        assert.equal(request.agentId, before.activeAgentId)
        assert.equal(request.sessionId, 'current-session')
        reportId = request.reportId
      }
      blocked = false; fs.statSync = originalStat; fs.renameSync = originalRename; syncBuiltinESMExports()
      oldGate.resolve(); await bounded(oldRun)
      const final = team.listTasks(group.name)[0]
      assert.equal(final.status, mode === 'done' ? 'done' : 'cancelled')
      assert.equal(final.attempt, before.attempt)
      if (mode === 'done') assert.equal(final.result, 'SUCCESSOR-RESULT')
      if (reportId) assert.equal(final.reportId, reportId)
      assert.equal(effects, 0)
      assert(!fs.existsSync(join(f.root, 'effects.log')))
      assert.equal(models, running ? 2 : 1)
      assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, mode === 'done' ? 0 : 1)
      assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
    } finally {
      blocked = false; fs.statSync = originalStat; fs.renameSync = originalRename; syncBuiltinESMExports()
      oldGate.resolve(); newGate.resolve(); await team.close(1000); await Promise.allSettled([oldRun, newRun]); await f.close()
    }
  })
}

for (const mode of ['normal', 'read'] as const) await check('旧取消日志清理失败时再次取消新租约 ' + mode + '，保存新意图并停止当前模型', async () => {
  const starts = [deferred(), deferred()], gates = [deferred(), deferred()]
  let models = 0, blocked = true, cleanupBlocked = false, readBlocked = false, retiredReportId: string | undefined
  const signals: (AbortSignal | undefined)[] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    const index = models++
    signals.push(options.signal); starts[index]?.resolve()
    await resolveOnAbort(gates[index].promise, options.signal, undefined)
    if (options.signal?.aborted) return
    yield { type: 'text', text: 'UNEXPECTED' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const originalStat = fs.statSync, originalRename = fs.renameSync, originalUnlink = fs.unlinkSync
  const tasksFile = join(root, 'audit', 'tasks.json')
  let oldRun: Promise<string> | undefined, newRun: Promise<string> | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'OLD-CANCEL', undefined, [], 2)
    fs.statSync = ((path, options) => {
      if (readBlocked && String(path) === tasksFile) throw Object.assign(new Error('NEW-CANCEL-READ-EACCES'), { code: 'EACCES' })
      return originalStat(path, options)
    }) as typeof fs.statSync
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === tasksFile && String(source).endsWith('.tmp')) {
        if (JSON.parse(fs.readFileSync(source, 'utf8')).some((item: { status: string }) => item.status === 'cancelled')) {
          throw Object.assign(new Error('OLD-CANCEL-WRITE-EIO'), { code: 'EIO' })
        }
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    fs.unlinkSync = ((path) => {
      if (cleanupBlocked && String(path).includes('tasks.pending') && String(path).endsWith('.json')
        && fs.existsSync(path) && JSON.parse(fs.readFileSync(path, 'utf8')).reportId === retiredReportId) {
        throw Object.assign(new Error('OLD-CANCEL-CLEANUP-EACCES'), { code: 'EACCES' })
      }
      return originalUnlink(path)
    }) as typeof fs.unlinkSync
    syncBuiltinESMExports()
    oldRun = team.runTask(group, task, 'alice')
    await bounded(starts[0].promise)
    assert(team.cancelTask(group.name, task.id)); await bounded(oldRun)
    const oldRequest = store.loadTaskSettlements(group.name).find((entry) => entry.kind === 'cancel')!
    assert(oldRequest)
    retiredReportId = oldRequest.reportId; cleanupBlocked = true
    store.mutateTasks(group.name, (tasks) => {
      tasks[0].status = 'todo'; tasks[0].title = 'NEW-CANCEL'; tasks[0].leaseId = undefined
      tasks[0].leaseExpiresAt = undefined; tasks[0].activeAgentId = undefined
    })
    team.setSessionId('new-session')
    newRun = team.runTask(group, task, 'alice')
    await bounded(starts[1].promise)
    const current = store.listTasks(group.name)[0]
    assert.notEqual(current.leaseId, oldRequest.leaseId)
    assert.equal(store.loadTaskSettlements(group.name).find((entry) => entry.kind === 'cancel')?.reportId, oldRequest.reportId)
    cleanupBlocked = false
    readBlocked = mode === 'read'
    assert(team.cancelTask(group.name, task.id)); await bounded(newRun)
    assert.equal(signals[1]?.aborted, true)
    const records = store.loadTaskSettlements(group.name).filter((entry) => entry.kind === 'cancel' && entry.leaseId === current.leaseId)
    assert.equal(records.length, 1)
    assert.equal(records[0].leaseId, current.leaseId)
    assert.equal(records[0].sessionId, 'new-session')
    assert.notEqual(records[0].reportId, oldRequest.reportId)
    blocked = false; readBlocked = false
    const final = team.listTasks(group.name)[0]
    assert.equal(final.status, 'cancelled')
    assert.equal(final.reportId, records[0].reportId)
    assert.equal(final.attempt, 2)
    assert.equal(models, 2)
    assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 1)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
  } finally {
    blocked = false; cleanupBlocked = false; readBlocked = false; fs.statSync = originalStat; fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports()
    for (const gate of gates) gate.resolve()
    await team.close(1000); await Promise.allSettled([oldRun, newRun]); await f.close()
  }
})

await check('同租约的执行 Agent 已变化，旧取消记录不会取消新身份', async () => {
  const started = deferred(), gate = deferred()
  let blocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined)
    if (!options.signal?.aborted) yield { type: 'done' }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const original = fs.renameSync, tasksFile = join(root, 'audit', 'tasks.json')
  let execution: Promise<string> | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'AGENT-CANCEL')
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === tasksFile && String(source).endsWith('.tmp')) {
        if (JSON.parse(fs.readFileSync(source, 'utf8')).some((item: { status: string }) => item.status === 'cancelled')) {
          throw Object.assign(new Error('AGENT-CANCEL-EIO'), { code: 'EIO' })
        }
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    execution = team.runTask(group, task, 'alice')
    await bounded(started.promise)
    assert(team.cancelTask(group.name, task.id)); await bounded(execution)
    const oldRequest = store.loadTaskSettlements(group.name).find((entry) => entry.kind === 'cancel')!
    assert(oldRequest.agentId)
    store.mutateTasks(group.name, (tasks) => { tasks[0].activeAgentId = 'successor-agent'; tasks[0].result = 'SUCCESSOR' })
    blocked = false
    const current = team.listTasks(group.name)[0]
    assert.equal(current.status, 'in_progress')
    assert.equal(current.activeAgentId, 'successor-agent')
    assert.equal(current.result, 'SUCCESSOR')
    assert.equal(current.leaseId, oldRequest.leaseId)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
    assert.equal(team.readLeadMail().length, 0)
    assert(team.cancelTask(group.name, task.id))
    assert.equal(team.listTasks(group.name)[0].status, 'cancelled')
    assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 1)
  } finally { blocked = false; fs.renameSync = original; syncBuiltinESMExports(); gate.resolve(); await team.close(1000); await Promise.allSettled([execution]); await f.close() }
})

await check('同任务多份结果待保存时取消当前结果，旧结果不干扰取消', async () => {
  let models = 0, blocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    models++; yield { type: 'text', text: models === 1 ? 'OLD-RESULT' : 'NEW-RESULT' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const originalRename = fs.renameSync, originalUnlink = fs.unlinkSync, tasksFile = join(root, 'audit', 'tasks.json')
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'PENDING-CANCEL', undefined, [], 2)
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === tasksFile && String(source).endsWith('.tmp')
        && JSON.parse(fs.readFileSync(source, 'utf8')).some((item: { status: string }) => item.status === 'done' || item.status === 'cancelled')) {
        throw Object.assign(new Error('MULTIPLE-RESULTS-EIO'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    fs.unlinkSync = ((path) => {
      if (blocked && String(path).includes('tasks.pending') && String(path).endsWith('.json')) {
        throw Object.assign(new Error('OLD-RESULT-CLEANUP-EACCES'), { code: 'EACCES' })
      }
      return originalUnlink(path)
    }) as typeof fs.unlinkSync
    syncBuiltinESMExports()
    assert.match(await bounded(team.runTask(group, task, 'alice')), /待保存/)
    const oldLease = store.listTasks(group.name)[0].leaseId
    store.mutateTasks(group.name, (tasks) => { tasks[0].status = 'todo'; tasks[0].leaseId = undefined; tasks[0].activeAgentId = undefined; tasks[0].leaseExpiresAt = undefined })
    team.setSessionId('current-session')
    assert.match(await bounded(team.runTask(group, task, 'alice')), /待保存/)
    const current = store.listTasks(group.name)[0]
    assert.notEqual(current.leaseId, oldLease)
    assert.equal(store.loadTaskSettlements(group.name).length, 2)
    assert(team.cancelTask(group.name, task.id))
    const request = store.loadTaskSettlements(group.name).find((entry) => entry.kind === 'cancel')!
    assert.equal(request.leaseId, current.leaseId)
    assert.equal(request.sessionId, 'current-session')
    blocked = false
    const final = team.listTasks(group.name)[0]
    assert.equal(final.status, 'cancelled')
    assert.equal(final.reportId, request.reportId)
    assert.equal(final.attempt, 2)
    assert.equal(models, 2)
    assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 1)
    assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
  } finally { blocked = false; fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})

await check('取消旧领取与新领取交错时，旧信号不能中止新模型或真实写入', async () => {
  const returned = deferred(), oldGate = deferred(), started = deferred(), gate = deferred()
  let models = 0, effects = 0, oldSignal: AbortSignal | undefined, newSignal: AbortSignal | undefined
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (models === 2) {
      newSignal = options.signal; started.resolve(); await resolveOnAbort(gate.promise, newSignal, undefined)
      if (newSignal?.aborted) return
      yield { type: 'tool_call', id: 'new-write', name: 'write_file', arguments: {} }; return
    }
    yield { type: 'text', text: models === 1 ? 'OLD-RESULT' : 'NEW-RESULT' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  let oldRun: Promise<string> | undefined, newRun: Promise<string> | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    f.registry.register({ name: 'write_file', description: '新执行真实写入', parameters: { type: 'object' }, async execute() {
      effects++; fs.appendFileSync(join(f.root, 'effects.log'), 'NEW-EFFECT\n'); return { success: true, output: 'NEW-EFFECT' }
    } })
    const originalExecute = host.execute.bind(host), originalCancel = host.cancel.bind(host)
    let executions = 0, interleaved = false
    host.execute = async (title, taskId, signal) => {
      const first = ++executions === 1
      if (first) oldSignal = signal
      const result = await originalExecute(title, taskId, signal)
      if (first) { returned.resolve(); await oldGate.promise }
      return result
    }
    const task = team.addTask(group.name, 'INTERLEAVED-CANCEL', undefined, [], 2)
    host.cancel = (taskId, signal) => {
      if (!interleaved) {
        interleaved = true
        store.mutateTasks(group.name, (tasks) => { tasks[0].status = 'todo'; tasks[0].leaseId = undefined; tasks[0].activeAgentId = undefined; tasks[0].leaseExpiresAt = undefined })
        newRun = team.runTask(group, task, 'alice')
      }
      return originalCancel(taskId, signal)
    }
    oldRun = team.runTask(group, task, 'alice')
    await bounded(returned.promise)
    assert(team.cancelTask(group.name, task.id))
    await bounded(started.promise)
    assert.equal(oldSignal?.aborted, true)
    assert.equal(newSignal?.aborted, false)
    assert.equal(originalCancel(task.id, oldSignal), false)
    const lease = store.listTasks(group.name)[0].leaseId
    oldGate.resolve(); await bounded(oldRun)
    assert.equal(store.listTasks(group.name)[0].leaseId, lease)
    gate.resolve(); await bounded(newRun!)
    assert.equal(team.listTasks(group.name)[0].status, 'done')
    assert.equal(team.listTasks(group.name)[0].result, 'NEW-RESULT')
    assert.equal(effects, 1)
    assert.equal(fs.readFileSync(join(f.root, 'effects.log'), 'utf8'), 'NEW-EFFECT\n')
    assert.equal(models, 3)
    assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 0)
    assert.equal(team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
  } finally { oldGate.resolve(); gate.resolve(); await team.close(1000); await Promise.allSettled([oldRun, newRun]); await f.close() }
})

await check('另一实例尚未恢复成员时也能取消当前租约，原执行者在心跳后停止', async () => {
  const started = deferred(), gate = deferred()
  let models = 0, signal: AbortSignal | undefined
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; signal = options.signal; started.resolve()
    await resolveOnAbort(gate.promise, signal, undefined)
    if (!signal?.aborted) yield { type: 'done' }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
  const team = new TeamManager(root, f.root, options), peer = new TeamManager(root, f.root, options)
  let scheduler: TeamTaskScheduler | undefined, execution: Promise<string> | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    scheduler = new TeamTaskScheduler({ store, mail: new TeamMail(join(root, '_shared', 'mail')),
      members: new Map([['alice', host]]), memberGroups: new Map([['alice', group.name]]), ctx: options.ctx, leaseMs: 3000, leaseHeartbeatMs: 20 })
    const task = scheduler.addTask(group.name, 'PEER-CANCEL')
    execution = scheduler.runTask(group, task, 'alice')
    await bounded(started.promise)
    assert.equal(peer.getMember('alice'), undefined)
    assert(peer.cancelTask(group.name, task.id))
    await bounded(execution)
    assert.equal(signal?.aborted, true)
    assert(!host.isBusy())
    assert.equal(store.listTasks(group.name)[0].status, 'cancelled')
    assert.equal(models, 1)
    assert.equal(peer.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 1)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
  } finally { gate.resolve(); await scheduler?.close(0); await peer.close(1000); await team.close(1000); await Promise.allSettled([execution]); await f.close() }
})

await check('读取任务失败且没有已知执行时显式报错，不伪造取消成功', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const original = fs.statSync, tasksFile = join(root, 'audit', 'tasks.json')
  try {
    const group = team.createGroup('audit', 'lead'), task = team.addTask(group.name, 'UNKNOWN-READ')
    fs.statSync = ((path, options) => {
      if (String(path) === tasksFile) throw Object.assign(new Error('UNKNOWN-READ-EACCES'), { code: 'EACCES' })
      return original(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports()
    assert.throws(() => team.cancelTask(group.name, task.id), /UNKNOWN-READ-EACCES/)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
    fs.statSync = original; syncBuiltinESMExports()
    assert.equal(store.listTasks(group.name)[0].status, 'todo')
    assert.equal(team.cancelTask('missing', task.id), false)
    assert(team.cancelTask(group.name, task.id))
    assert.equal(team.listTasks(group.name)[0].status, 'cancelled')
  } finally { fs.statSync = original; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})

console.log(`team_cancellation_lease_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
