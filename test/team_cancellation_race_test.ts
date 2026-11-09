import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import type { TeamTask, TeamTaskSettlement } from '../src/team/types.ts'
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
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('跨实例取消恢复超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(provider: Provider, options: { hooks?: HookEngine; needsApproval?: boolean; heartbeat?: boolean } = {}) {
  const f = await streamFixture(provider, options), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const settings = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
  const team = new TeamManager(root, f.root, settings), peer = new TeamManager(root, f.root, settings)
  const created = team.createGroup('audit', 'lead')
  const host = await team.spawnMember(created, 'alice', 'worker', { workdir: f.root, roleDefinition: null, needsApproval: options.needsApproval })
  const group = store.loadGroup(created.name)!, mail = new TeamMail(join(root, '_shared', 'mail'))
  const scheduler = new TeamTaskScheduler({ store, mail, members: new Map([['alice', host]]), memberGroups: new Map([['alice', group.name]]),
    ctx: f.chat.getToolContext(), leaseMs: 60000, leaseHeartbeatMs: options.heartbeat ? 20 : 30000 })
  return { ...f, root, store, team, peer, host, group, mail, scheduler,
    async close() { await peer.close(0); await scheduler.close(0); await team.close(1000); await f.close() },
  }
}

for (const mode of ['done', 'failed', 'timer', 'read-error'] as const) await check('已持久化的跨实例取消优先于 ' + mode + ' 结果，不改写终态或重试', async () => {
  const started = deferred(), gate = deferred(), checked = deferred(), hooks = new HookEngine([])
  let models = 0, completionHooks = 0, cancelBlocked = true, resultBlocked = mode === 'timer', readBlocked = false
  hooks.fire = async (event) => { if (event === 'task_completed') completionHooks++ }
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    models++; started.resolve(); await gate.promise
    if (mode === 'failed') throw new Error('REAL-FAILURE-AFTER-CANCEL')
    yield { type: 'text', text: 'REAL-RESULT-AFTER-CANCEL' }; yield { type: 'done' }
  } }
  const f = await fixture(provider, { hooks }), file = join(f.root, 'audit', 'tasks.json')
  const originalRename = fs.renameSync, originalRead = fs.readFileSync
  let execution: Promise<string> | undefined
  try {
    const task = f.scheduler.addTask(f.group.name, 'PEER-CANCEL-FIRST', undefined, [], 2)
    fs.renameSync = ((source, destination) => {
      if (String(destination) === file && String(source).endsWith('.tmp')) {
        const tasks = JSON.parse(originalRead(source, 'utf8')) as TeamTask[]
        if (cancelBlocked && tasks.some((item) => item.status === 'cancelled')) throw Object.assign(new Error('PEER-CANCEL-EIO'), { code: 'EIO' })
        if (resultBlocked && tasks.some((item) => item.status === 'done')) throw Object.assign(new Error('OWNER-RESULT-EIO'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    fs.readFileSync = ((path, options) => {
      if (readBlocked && String(path).includes('tasks.pending') && String(path).endsWith('.json')) {
        throw Object.assign(new Error('CANCEL-JOURNAL-EACCES'), { code: 'EACCES' })
      }
      return originalRead(path, options)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    execution = f.scheduler.runTask(f.group, task, 'alice'); await bounded(started.promise)
    if (mode === 'timer') { gate.resolve(); assert.match(await bounded(execution), /待保存/) }
    assert.throws(() => f.peer.cancelTask(f.group.name, task.id), /PEER-CANCEL-EIO/)
    const request = f.store.loadTaskSettlements(f.group.name).find((entry) => entry.kind === 'cancel')!
    assert(request); await f.peer.close(0)
    if (mode === 'read-error') readBlocked = true
    if (mode === 'timer') {
      const mutate = f.store.mutateTasks.bind(f.store)
      f.store.mutateTasks = (name, update) => {
        try { return mutate(name, update) } finally { checked.resolve() }
      }
      resultBlocked = false; await bounded(checked.promise)
    } else { gate.resolve(); await bounded(execution) }
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'in_progress')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    assert.equal(f.store.listTasks(f.group.name)[0].nextRetryAt, undefined)
    assert.equal(completionHooks, 0)
    readBlocked = false
    const remaining = f.store.loadTaskSettlements(f.group.name)
    assert(remaining.some((entry) => entry.reportId === request.reportId))
    if (mode === 'read-error') assert(remaining.some((entry) => entry.kind === 'result'))
    cancelBlocked = false
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'cancelled')
    assert.equal(f.store.listTasks(f.group.name)[0].reportId, request.reportId)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    f.scheduler.listTasks(f.group.name)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
    const mail = f.team.readLeadMail()
    assert.equal(mail.filter((message) => message.kind === 'task_cancelled').length, 1)
    assert.equal(mail.filter((message) => message.kind === 'task_result' || message.kind === 'task_retry').length, 0)
    assert.equal(models, 1); assert.equal(completionHooks, 0)
  } finally {
    cancelBlocked = false; resultBlocked = false; readBlocked = false
    fs.renameSync = originalRename; fs.readFileSync = originalRead; syncBuiltinESMExports(); gate.resolve()
    await f.close(); await Promise.allSettled([execution])
  }
})

for (const stage of ['model', 'start', 'approval', 'tool'] as const) await check('取消账本暂时不可写时，通过持久化意图停止 ' + stage + ' 等待和迟到写入', async () => {
  const started = deferred(), gate = deferred(), hooks = new HookEngine([])
  let models = 0, effects = 0, cancelBlocked = true, signal: AbortSignal | undefined
  hooks.fire = async (event, _context, currentSignal) => {
    if (stage === 'start' && event === 'subagent_start') { signal = currentSignal; started.resolve(); await gate.promise }
  }
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (stage === 'model') {
      signal = options.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return
    }
    if (models === 1) yield { type: 'tool_call', id: 'late-write', name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'UNEXPECTED-RESULT' }; yield { type: 'done' } }
  } }
  const f = await fixture(provider, { hooks, heartbeat: true, needsApproval: stage === 'approval' })
  const original = fs.renameSync, file = join(f.root, 'audit', 'tasks.json'), effectFile = join(f.root, 'effects.log')
  let execution: Promise<string> | undefined
  try {
    f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute(_args, ctx) {
      if (stage === 'tool') {
        signal = ctx.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
        if (signal?.aborted) return { success: false, output: '', error: '已取消' }
      }
      effects++; fs.appendFileSync(effectFile, 'UNEXPECTED-EFFECT\n'); return { success: true, output: 'UNEXPECTED-EFFECT' }
    } })
    const task = f.scheduler.addTask(f.group.name, 'CANCEL-WAIT')
    fs.renameSync = ((source, destination) => {
      if (cancelBlocked && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((item: TeamTask) => item.status === 'cancelled')) {
        throw Object.assign(new Error('CANCEL-WAIT-EIO'), { code: 'EIO' })
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    execution = f.scheduler.runTask(f.group, task, 'alice')
    if (stage === 'approval') await waitUntil(() => f.team.readLeadMail().some((message) => message.kind === 'approval_plan'))
    else await bounded(started.promise)
    assert.throws(() => f.peer.cancelTask(f.group.name, task.id), /CANCEL-WAIT-EIO/)
    const reportId = f.store.loadTaskSettlements(f.group.name).find((entry) => entry.kind === 'cancel')!.reportId
    await f.peer.close(0)
    await bounded(execution)
    if (stage === 'approval') {
      const plan = f.team.readLeadMail().find((message) => message.kind === 'approval_plan')!
      f.mail.send('lead', 'alice', 'APPROVE', { groupId: f.group.name, kind: 'approval_decision', taskId: task.id, correlationId: plan.correlationId })
    } else assert.equal(signal?.aborted, true)
    gate.resolve()
    assert.equal(effects, 0); assert(!fs.existsSync(effectFile)); assert(!f.host.isBusy())
    assert.equal(models, stage === 'start' || stage === 'approval' ? 0 : 1)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'in_progress')
    cancelBlocked = false
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'cancelled')
    assert.equal(f.store.listTasks(f.group.name)[0].reportId, reportId)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
  } finally {
    cancelBlocked = false; fs.renameSync = original; syncBuiltinESMExports(); gate.resolve()
    await f.close(); await Promise.allSettled([execution])
  }
})

for (const status of ['done', 'failed', 'progress'] as const) await check('等待任务的持久化取消阻止成员 ' + status + ' 更新覆盖取消版本', async () => {
  let models = 0, cancelBlocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
  const f = await fixture(provider), original = fs.renameSync, file = join(f.root, 'audit', 'tasks.json')
  try {
    const task = f.scheduler.addTask(f.group.name, 'QUEUED-CANCEL', 'alice')
    fs.renameSync = ((source, destination) => {
      if (cancelBlocked && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((item: TeamTask) => item.status === 'cancelled')) {
        throw Object.assign(new Error('QUEUED-CANCEL-EIO'), { code: 'EIO' })
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    assert(f.peer.cancelTask(f.group.name, task.id)); await f.peer.close(0)
    const request = f.store.loadTaskSettlements(f.group.name)[0], before = f.store.listTasks(f.group.name)[0]
    assert.throws(() => f.scheduler.updateTaskFromMember(f.group.name, 'alice', task.id,
      status === 'progress' ? { result: 'STALE-PROGRESS' } : { status, result: 'STALE-RESULT' }), /正在取消|已取消/)
    assert.deepEqual(f.store.listTasks(f.group.name)[0], before)
    cancelBlocked = false
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'cancelled')
    assert.equal(f.store.listTasks(f.group.name)[0].reportId, request.reportId)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 0)
    assert.equal(models, 0)
  } finally { cancelBlocked = false; fs.renameSync = original; syncBuiltinESMExports(); await f.close() }
})

for (const field of ['taskId', 'leaseId', 'agentId', 'memberName'] as const) await check('其他 ' + field + ' 的取消日志不停止当前执行或丢弃真实结果', async () => {
  const started = deferred(), gate = deferred()
  let models = 0, signal: AbortSignal | undefined
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; signal = options.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
    if (!signal?.aborted) { yield { type: 'text', text: 'VALID-CURRENT-RESULT' }; yield { type: 'done' } }
  } }
  const f = await fixture(provider, { heartbeat: true })
  let execution: Promise<string> | undefined
  try {
    const task = f.scheduler.addTask(f.group.name, 'CURRENT-LEASE')
    execution = f.scheduler.runTask(f.group, task, 'alice'); await bounded(started.promise)
    const current = f.store.listTasks(f.group.name)[0]
    const stale: TeamTaskSettlement = { kind: 'cancel', groupName: f.group.name, taskId: task.id, leaseId: current.leaseId,
      memberName: 'alice', agentId: current.activeAgentId, reportId: 'stale-report' }
    stale[field] = 'other-identity'; new TeamGroupStore(f.root).saveTaskSettlement(stale)
    const expiresAt = current.leaseExpiresAt!
    await waitUntil(() => f.store.listTasks(f.group.name)[0].leaseExpiresAt! > expiresAt)
    assert.equal(signal?.aborted, false)
    gate.resolve(); assert.equal(await bounded(execution), 'VALID-CURRENT-RESULT')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done'); assert.equal(models, 1)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
  } finally { gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
})

for (const mode of ['recover', 'close'] as const) await check('取消在 ' + mode + ' 重排前到达时保留当前租约和取消意图', async () => {
  const started = deferred(), gate = deferred()
  let models = 0, cancelBlocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined)
    if (!options.signal?.aborted) { yield { type: 'text', text: 'TOO-LATE' }; yield { type: 'done' } }
  } }
  const f = await fixture(provider), originalRename = fs.renameSync, originalMutate = f.store.mutateTasks.bind(f.store)
  const file = join(f.root, 'audit', 'tasks.json')
  let execution: Promise<string> | undefined
  try {
    const task = f.scheduler.addTask(f.group.name, 'CANCEL-BEFORE-REQUEUE', undefined, [], 2)
    execution = f.scheduler.runTask(f.group, task, 'alice'); await bounded(started.promise)
    f.store.mutateTasks(f.group.name, (tasks) => { tasks[0].leaseExpiresAt = 1 })
    fs.renameSync = ((source, destination) => {
      if (cancelBlocked && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((item: TeamTask) => item.status === 'cancelled')) {
        throw Object.assign(new Error('REQUEUE-CANCEL-EIO'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    let injected = false
    const cancel = () => { injected = true; assert.throws(() => f.peer.cancelTask(f.group.name, task.id), /REQUEUE-CANCEL-EIO/) }
    if (mode === 'recover') {
      f.store.mutateTasks = (name, update) => { if (!injected) cancel(); return originalMutate(name, update) }
      assert.deepEqual(f.scheduler.recoverStaleTasks(f.group.name), [])
    } else { cancel(); await bounded(f.scheduler.close(0)) }
    assert(injected); await f.peer.close(0)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'in_progress')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    assert(f.store.listTasks(f.group.name)[0].leaseId)
    const request = f.store.loadTaskSettlements(f.group.name).find((entry) => entry.kind === 'cancel')!
    assert(request)
    cancelBlocked = false
    if (mode === 'close') f.scheduler.listTasks(f.group.name)
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'cancelled')
    gate.resolve(); await bounded(execution)
    assert.equal(f.store.listTasks(f.group.name)[0].reportId, request.reportId)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1); assert.equal(models, 1)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 1)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_retry' || message.kind === 'task_result').length, 0)
  } finally {
    cancelBlocked = false; fs.renameSync = originalRename; syncBuiltinESMExports(); f.store.mutateTasks = originalMutate; gate.resolve()
    await f.close(); await Promise.allSettled([execution])
  }
})

await check('真实进程取消与完成提交交错，共享任务锁保持发布顺序和唯一终态', async () => {
  let models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'COMMITTED-FIRST' }; yield { type: 'done' } } }
  const f = await fixture(provider), original = fs.renameSync
  const file = join(f.root, 'audit', 'tasks.json'), queue = join(f.root, 'audit', 'tasks.lock.queue')
  const ready = join(f.root, 'ready'), gate = join(f.root, 'gate'), finished = join(f.root, 'finished')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const task = f.scheduler.addTask(f.group.name, 'ATOMIC-COMPLETION')
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamManager } from ${JSON.stringify(new URL('../src/team/index.ts', import.meta.url).href)}
      import { ToolRegistry } from ${JSON.stringify(new URL('../src/tools/registry.ts', import.meta.url).href)}
      const [root, cwd, taskId, ready, gate, finished] = process.argv.slice(1)
      const manager = new TeamManager(root, cwd, {
        provider: { protocol: 'openai', async *streamChat() { yield { type: 'done' } } },
        registry: new ToolRegistry(), ctx: { cwd },
      })
      writeFileSync(ready, 'ready')
      const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
      while (!existsSync(gate)) {
        if (Date.now() >= end) throw new Error('取消提交交错启动超时')
        Atomics.wait(wait, 0, 0, 2)
      }
      const cancelled = manager.cancelTask('audit', taskId)
      await manager.close(0)
      writeFileSync(finished, JSON.stringify({ cancelled }))
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.root, join(f.root, '..'), task.id, ready, gate, finished], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`取消子进程失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {})
    timer = setTimeout(() => child?.kill(), 8000)
    await waitUntil(() => fs.existsSync(ready))
    let interleaved = false
    fs.renameSync = ((source, destination) => {
      if (!interleaved && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((item: TeamTask) => item.status === 'done')) {
        interleaved = true; fs.writeFileSync(gate, 'go')
        const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 3000
        while (!fs.existsSync(queue) && !fs.existsSync(finished)) {
          if (Date.now() >= end) throw new Error('取消提交进程交错超时')
          Atomics.wait(wait, 0, 0, 2)
        }
        assert(!fs.existsSync(finished))
        assert(!f.store.loadTaskSettlements(f.group.name).some((entry) => entry.kind === 'cancel'))
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    assert.equal(await bounded(f.scheduler.runTask(f.group, task, 'alice')), 'COMMITTED-FIRST')
    assert(interleaved); await bounded(exited)
    assert.deepEqual(JSON.parse(fs.readFileSync(finished, 'utf8')), { cancelled: false })
    assert.equal(f.scheduler.listTasks(f.group.name)[0].status, 'done')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_cancelled').length, 0)
    assert.equal(models, 1)
    assert(!fs.existsSync(join(f.root, 'audit', 'tasks.lock'))); assert(!fs.existsSync(queue))
  } finally {
    fs.renameSync = original; syncBuiltinESMExports(); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

console.log(`\n团队取消交错: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
