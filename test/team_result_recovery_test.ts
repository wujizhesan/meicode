import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import type { MemberHost } from '../src/team/member.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import type { TeamTask, TeamTaskOutcome, TeamTaskSettlement } from '../src/team/types.ts'
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
    if (Date.now() >= end) throw new Error('任务结果恢复超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}

async function pendingFixture() {
  // biome-ignore lint/correctness/useYield: 桩 provider 只负责抛错断言「不该调用模型」，不需要 yield
  const provider: Provider = { protocol: 'openai', async *streamChat() { throw new Error('恢复测试不得调用模型') } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const group = store.createGroup('audit', 'lead')
  const task: TeamTask = { id: 'pending-task', title: 'PENDING-RESULT', status: 'in_progress', assignee: 'alice',
    leaseId: 'pending-lease', activeAgentId: 'pending-agent', leaseExpiresAt: 1, attempt: 1, maxAttempts: 2 }
  store.saveTasks(group.name, [task])
  const scheduler = new TeamTaskScheduler({ store, mail: new TeamMail(join(root, '_shared', 'mail')), members: new Map(),
    memberGroups: new Map(), ctx: f.chat.getToolContext() })
  const entry: TeamTaskSettlement = { kind: 'result', groupName: group.name, taskId: task.id, memberName: 'alice',
    leaseId: task.leaseId, agentId: task.activeAgentId, reportId: 'pending-report', result: {
      status: 'done', text: 'DURABLE-RESULT', report: { reportId: 'pending-report', status: 'done', summary: 'DURABLE-RESULT' },
    } }
  return { ...f, teamRoot: root, store, group, task, scheduler, entry,
    async close() { await scheduler.close(0); await f.close() },
  }
}

for (const mode of ['recover', 'close'] as const) for (const status of ['done', 'failed'] as const) for (const maxAttempts of status === 'done' ? [1, 2] : [1]) await check('真实 ' + status + ' 结果在 ' + mode + ' 重排前发布，只补存且保留次数与原始结果，上限 ' + maxAttempts, async () => {
  let models = 0, effects = 0, blocked = true
  const ready = deferred(), gate = deferred()
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    models++
    if (models % 2 === 1) yield { type: 'tool_call', id: 'actual-effect-' + models, name: 'write_file', arguments: {} }
    else {
      if (status === 'failed') throw new Error('ACTUAL-ERROR-AFTER-EFFECT')
      yield { type: 'text', text: 'ACTUAL-WORK-COMPLETED' }; yield { type: 'done' }
    }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team')
  const store = new TeamGroupStore(root), peerStore = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const members = new Map<string, MemberHost>(), memberGroups = new Map<string, string>()
  const source = new TeamTaskScheduler({ store, mail: new TeamMail(join(root, '_shared', 'mail')), members,
    memberGroups, ctx: f.chat.getToolContext(), leaseMs: 60000, leaseHeartbeatMs: 30000 })
  let peer: TeamTaskScheduler | undefined, execution: Promise<string> | undefined, outcome: TeamTaskOutcome | undefined
  const originalRename = fs.renameSync, file = join(root, 'audit', 'tasks.json'), effectsFile = join(f.root, 'effects.log')
  try {
    const group = team.createGroup('audit', 'lead')
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    members.set('alice', host); memberGroups.set('alice', group.name)
    peer = new TeamTaskScheduler({ store: peerStore, mail: new TeamMail(join(root, '_shared', 'mail')), members: new Map([['alice', host]]),
      memberGroups: new Map([['alice', group.name]]), ctx: f.chat.getToolContext(), leaseMs: 60000, leaseHeartbeatMs: 30000 })
    f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
      effects++; fs.appendFileSync(effectsFile, 'ACTUAL-EFFECT\n'); return { success: true, output: 'ACTUAL-EFFECT' }
    } })
    const execute = host.execute.bind(host)
    host.execute = async (title, taskId, signal) => {
      const result = await execute(title, taskId, signal)
      outcome = structuredClone(result); ready.resolve(); await gate.promise
      return result
    }
    const task = source.addTask(group.name, 'COMPLETED-BEFORE-RECOVERY', 'alice', [], maxAttempts)
    execution = source.runTask(group, task, 'alice'); await bounded(ready.promise)
    assert.equal(outcome?.status, status); assert.equal(models, 2); assert.equal(effects, 1)
    store.mutateTasks(group.name, (tasks) => { tasks[0].leaseExpiresAt = 1 })
    const current = store.listTasks(group.name)[0]
    const entry: TeamTaskSettlement = { kind: 'result', groupName: group.name, taskId: task.id, memberName: 'alice', leaseId: current.leaseId,
      agentId: current.activeAgentId, sessionId: f.chat.getToolContext().sessionId, reportId: outcome!.report.reportId, result: outcome! }
    fs.renameSync = ((from, destination) => {
      if (blocked && String(destination) === file && String(from).endsWith('.tmp') && JSON.parse(fs.readFileSync(from, 'utf8')).some((item: TeamTask) => item.reportId === outcome!.report.reportId && item.status !== 'in_progress')) {
        throw Object.assign(new Error('COMPLETED-RESULT-EIO'), { code: 'EIO' })
      }
      return originalRename(from, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    const target = mode === 'close' ? source : peer, mutate = (mode === 'close' ? store : peerStore).mutateTasks.bind(mode === 'close' ? store : peerStore)
    let injected = false
    const targetStore = mode === 'close' ? store : peerStore
    targetStore.mutateTasks = (name, update) => {
      if (!injected) { injected = true; store.saveTaskSettlement(entry) }
      return mutate(name, update)
    }
    if (mode === 'close') await bounded(target.close(0))
    else assert.deepEqual(target.recoverStaleTasks(group.name), [])
    assert(injected)
    assert.equal(store.listTasks(group.name)[0].status, 'in_progress')
    assert.equal(store.listTasks(group.name)[0].attempt, 1)
    assert.equal(store.listTasks(group.name)[0].leaseId, current.leaseId)
    assert.equal(store.loadTaskSettlements(group.name)[0].reportId, entry.reportId)
    assert.deepEqual(peer.scheduleReadyTasks(group.name), [])
    assert.equal(models, 2); assert.equal(effects, 1)
    blocked = false
    if (mode === 'close') peer.listTasks(group.name)
    await waitUntil(() => store.listTasks(group.name)[0].status === status)
    gate.resolve(); await bounded(execution)
    const saved = peer.listTasks(group.name)[0]
    assert.equal(saved.reportId, entry.reportId); assert.equal(saved.result, outcome!.text.slice(0, 4000))
    assert.equal(saved.attempt, 1); assert.equal(saved.leaseId, undefined); assert.equal(saved.nextRetryAt, undefined)
    if (status === 'failed') assert.match(saved.lastError!, /ACTUAL-ERROR-AFTER-EFFECT/)
    assert.equal(models, 2); assert.equal(effects, 1); assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'ACTUAL-EFFECT\n')
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
    const mail = team.readLeadMail().filter((message) => message.kind === 'task_result')
    assert.equal(mail.length, 1); assert.equal(mail[0].correlationId, entry.reportId)
  } finally {
    blocked = false; fs.renameSync = originalRename; syncBuiltinESMExports(); gate.resolve()
    await source.close(0); await peer?.close(0); await team.close(1000); await Promise.allSettled([execution]); await f.close()
  }
})

for (const field of ['taskId', 'leaseId', 'agentId', 'memberName', 'missing-agent'] as const) await check('其他 ' + field + ' 的结果日志不阻止当前过期租约恢复', async () => {
  const f = await pendingFixture(), mutate = f.store.mutateTasks.bind(f.store)
  try {
    const entry = structuredClone(f.entry)
    if (field === 'missing-agent') delete entry.agentId
    else entry[field] = 'other-identity'
    let injected = false
    f.store.mutateTasks = (name, update) => {
      if (!injected) { injected = true; new TeamGroupStore(f.teamRoot).saveTaskSettlement(entry) }
      return mutate(name, update)
    }
    const recovered = f.scheduler.recoverStaleTasks(f.group.name)
    assert(injected); assert.equal(recovered.length, 1)
    assert.equal(recovered[0].status, 'todo'); assert.equal(recovered[0].attempt, 1)
    assert.equal(recovered[0].leaseId, undefined)
    assert(recovered[0].reportId); assert.notEqual(recovered[0].reportId, entry.reportId)
    assert.match(recovered[0].report!.summary, /租约过期/)
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'todo'); assert.equal(current.reportId, recovered[0].reportId)
  } finally { await f.close() }
})

await check('恢复时读取结果日志失败，保留租约和次数；读取恢复后只补存结果', async () => {
  const f = await pendingFixture(), mutate = f.store.mutateTasks.bind(f.store), originalRead = fs.readFileSync
  let blocked = false, injected = false
  try {
    f.store.mutateTasks = (name, update) => {
      if (!injected) { injected = true; new TeamGroupStore(f.teamRoot).saveTaskSettlement(f.entry); blocked = true }
      return mutate(name, update)
    }
    fs.readFileSync = ((path, options) => {
      if (blocked && String(path).includes('tasks.pending') && String(path).endsWith('.json')) throw Object.assign(new Error('RESULT-READ-EACCES'), { code: 'EACCES' })
      return originalRead(path, options)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    assert.throws(() => f.scheduler.recoverStaleTasks(f.group.name), /RESULT-READ-EACCES/)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'in_progress')
    assert.equal(f.store.listTasks(f.group.name)[0].leaseId, f.task.leaseId)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    blocked = false
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [f.entry])
    assert.equal(f.scheduler.listTasks(f.group.name)[0].status, 'done')
    assert.equal(f.store.listTasks(f.group.name)[0].reportId, f.entry.reportId)
    assert.equal(f.store.listTasks(f.group.name)[0].result, f.entry.result!.text)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
  } finally { blocked = false; fs.readFileSync = originalRead; syncBuiltinESMExports(); await f.close() }
})

await check('真实进程的结果发布与重排提交交错，恢复先提交后迟到结果不覆盖新状态', async () => {
  const f = await pendingFixture(), original = fs.renameSync
  const ready = join(f.root, 'ready'), gate = join(f.root, 'gate'), finished = join(f.root, 'finished')
  const file = join(f.teamRoot, 'audit', 'tasks.json'), queue = join(f.teamRoot, 'audit', 'tasks.lock.queue')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, raw, ready, gate, finished] = process.argv.slice(1)
      writeFileSync(ready, 'ready')
      const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
      while (!existsSync(gate)) {
        if (Date.now() >= end) throw new Error('结果发布交错启动超时')
        Atomics.wait(wait, 0, 0, 2)
      }
      new TeamGroupStore(root).saveTaskSettlement(JSON.parse(raw))
      writeFileSync(finished, 'finished')
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, JSON.stringify(f.entry), ready, gate, finished], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`结果发布子进程失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {})
    timer = setTimeout(() => child?.kill(), 8000)
    await waitUntil(() => fs.existsSync(ready))
    let interleaved = false
    fs.renameSync = ((source, destination) => {
      if (!interleaved && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((task: TeamTask) => task.status === 'todo')) {
        interleaved = true; fs.writeFileSync(gate, 'go')
        const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 3000
        while (!fs.existsSync(queue) && !fs.existsSync(finished)) {
          if (Date.now() >= end) throw new Error('结果发布进程交错超时')
          Atomics.wait(wait, 0, 0, 2)
        }
        assert(!fs.existsSync(finished))
        assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    const recovered = f.scheduler.recoverStaleTasks(f.group.name)
    assert(interleaved); assert.equal(recovered.length, 1); await bounded(exited)
    const current = f.scheduler.listTasks(f.group.name)[0]
    assert.equal(current.status, 'todo'); assert.equal(current.reportId, recovered[0].reportId)
    assert(current.reportId); assert.notEqual(current.reportId, f.entry.reportId)
    assert.match(current.report!.summary, /租约过期/)
    assert.equal(current.attempt, 1); assert.equal(current.leaseId, undefined)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
    assert(!fs.existsSync(join(f.teamRoot, 'audit', 'tasks.lock'))); assert(!fs.existsSync(queue))
  } finally {
    fs.renameSync = original; syncBuiltinESMExports(); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

console.log(`\n团队结果恢复: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
