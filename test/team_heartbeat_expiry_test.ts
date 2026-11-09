import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
const pause = (ms = 80) => new Promise<void>((done) => setTimeout(done, ms))
async function fixture(stage: 'model' | 'start' | 'tool' = 'model') {
  let models = 0, effects = 0, signal: AbortSignal | undefined
  const started = deferred(), gate = deferred(), hooks = new HookEngine([])
  hooks.fire = async (event, _payload, currentSignal) => {
    if (stage === 'start' && event === 'subagent_start') {
      signal = currentSignal; started.resolve(); await resolveOnAbort(gate.promise, currentSignal, undefined)
    }
  }
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (models === 1) {
      if (stage === 'model') {
        signal = options.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
        if (signal?.aborted) return
      }
      yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
    } else { yield { type: 'text', text: 'HEARTBEAT-VALID' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const group = team.createGroup('audit', 'captain')
  const host = await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
  const mail = new TeamMail(join(root, '_shared', 'mail')); mail.register('captain')
  const scheduler = new TeamTaskScheduler({ store, mail, members: new Map([['alice', host]]), memberGroups: new Map([['alice', 'audit']]),
    ctx: f.chat.getToolContext(), leaseMs: 60000, leaseHeartbeatMs: 15 })
  const effectsFile = join(f.root, 'effects.log'), tasksFile = join(root, 'audit', 'tasks.json')
  f.registry.register({ name: 'write_file', description: '心跳有效期真实写入', parameters: { type: 'object' }, async execute(_args, context) {
    if (stage === 'tool') {
      signal = context.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return { success: false, output: '', error: 'ABORTED' }
    }
    effects++; fs.appendFileSync(effectsFile, 'EFFECT\n'); return { success: true, output: 'EFFECT' }
  } })
  const task = scheduler.addTask('audit', 'HEARTBEAT-EXPIRY', 'alice')
  return { ...f, root, team, store, group, host, scheduler, task, mail, started, gate, effectsFile, tasksFile,
    get models() { return models }, get effects() { return effects }, get signal() { return signal },
    run() { return scheduler.runTask(group, task, 'alice') },
    async close() { gate.resolve(); await scheduler.close(1000); await team.close(1000); await f.close() },
  }
}
function heartbeatFault(f: Awaited<ReturnType<typeof fixture>>, kind: 'read' | 'write') {
  const mutate = f.store.mutateTasks.bind(f.store), rename = fs.renameSync
  let faults = 0
  if (kind === 'read') f.store.mutateTasks = (() => { faults++; throw Object.assign(new Error('HEARTBEAT-READ-EACCES'), { code: 'EACCES' }) }) as TeamGroupStore['mutateTasks']
  else {
    fs.renameSync = ((source, destination) => {
      if (String(destination) === f.tasksFile && String(source).endsWith('.tmp')
        && JSON.parse(fs.readFileSync(source, 'utf8')).some((task: { status: string }) => task.status === 'in_progress')) {
        faults++; throw Object.assign(new Error('HEARTBEAT-SAVE-EIO'), { code: 'EIO' })
      }
      return rename(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
  }
  return { get faults() { return faults }, restore() { f.store.mutateTasks = mutate; fs.renameSync = rename; syncBuiltinESMExports() } }
}
for (const expiry of ['zero', 'boundary', 'past'] as const) {
  await check(`心跳发现 ${expiry} 过期租约不复活，停止模型且不产生写入`, async () => {
    const f = await fixture(), now = Date.now
    let execution: Promise<string> | undefined
    try {
      execution = f.run(); await bounded(f.started.promise)
      const instant = now()
      Date.now = () => instant
      f.store.updateTask('audit', f.task.id, { leaseExpiresAt: expiry === 'zero' ? 0 : expiry === 'boundary' ? instant : instant - 1 })
      await pause()
      assert.equal(f.signal?.aborted, true)
      f.gate.resolve(); await bounded(execution)
      assert.equal(f.models, 1); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
      const saved = f.store.listTasks('audit')[0]
      assert.equal(saved.status, 'failed'); assert.equal(saved.attempt, 1); assert.equal(saved.leaseId, undefined)
      assert.equal(f.mail.read('captain').filter((message) => message.kind === 'task_result').length, 1)
    } finally { Date.now = now; f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
  })
}
for (const kind of ['read', 'write'] as const) {
  await check(`持续 ${kind} 续期故障超过已保存有效期，停止旧执行且不写入`, async () => {
    const f = await fixture(), now = Date.now
    let execution: Promise<string> | undefined, fault: ReturnType<typeof heartbeatFault> | undefined
    try {
      execution = f.run(); await bounded(f.started.promise)
      const expiry = f.store.listTasks('audit')[0].leaseExpiresAt!
      fault = heartbeatFault(f, kind)
      let instant = kind === 'write' ? expiry - 1000 : expiry + 1
      Date.now = () => instant
      if (kind === 'write') {
        await pause(35)
        assert(fault.faults > 0); assert.equal(f.signal?.aborted, false)
        assert.equal(f.store.listTasks('audit')[0].leaseExpiresAt, expiry)
        instant = expiry + 1
      }
      await pause()
      assert(fault.faults > 0)
      assert.equal(f.signal?.aborted, true)
      fault.restore(); f.gate.resolve(); await bounded(execution)
      assert.equal(f.models, 1); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
      assert.equal(f.store.listTasks('audit')[0].status, 'failed')
      assert.equal(f.store.listTasks('audit')[0].attempt, 1)
      assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    } finally { fault?.restore(); Date.now = now; f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
  })
  await check(`已成功续期后短暂 ${kind} 故障使用最新有效期，不误取消或重复执行`, async () => {
    const f = await fixture(), now = Date.now
    let execution: Promise<string> | undefined, fault: ReturnType<typeof heartbeatFault> | undefined
    try {
      execution = f.run(); await bounded(f.started.promise)
      const originalExpiry = f.store.listTasks('audit')[0].leaseExpiresAt!
      let instant = originalExpiry - 1000
      Date.now = () => instant
      await pause(35)
      const renewed = f.store.listTasks('audit')[0].leaseExpiresAt!
      assert(renewed > originalExpiry)
      fault = heartbeatFault(f, kind); instant = originalExpiry + 1000
      await pause()
      assert(fault.faults > 0); assert.equal(f.signal?.aborted, false)
      assert.equal(f.effects, 0)
      fault.restore(); f.gate.resolve(); await bounded(execution)
      assert.equal(f.models, 2); assert.equal(f.effects, 1)
      assert.equal(f.store.listTasks('audit')[0].status, 'done')
      assert.equal(f.store.listTasks('audit')[0].result, 'HEARTBEAT-VALID')
      assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'EFFECT\n')
      assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
    } finally { fault?.restore(); Date.now = now; f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
  })
}
await check('续期写盘失败后读取也失败，未保存的有效期不能延长执行', async () => {
  const f = await fixture(), now = Date.now
  let execution: Promise<string> | undefined, fault: ReturnType<typeof heartbeatFault> | undefined
  try {
    execution = f.run(); await bounded(f.started.promise)
    const expiry = f.store.listTasks('audit')[0].leaseExpiresAt!
    let instant = expiry - 1000
    Date.now = () => instant; fault = heartbeatFault(f, 'write')
    await pause(35)
    assert(fault.faults > 0); assert.equal(f.signal?.aborted, false)
    assert.equal(f.store.listTasks('audit')[0].leaseExpiresAt, expiry)
    fault.restore(); fault = heartbeatFault(f, 'read'); instant = expiry + 1
    await pause()
    assert(fault.faults > 0); assert.equal(f.signal?.aborted, true)
    fault.restore(); f.gate.resolve(); await bounded(execution)
    assert.equal(f.models, 1); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert.equal(f.store.listTasks('audit')[0].status, 'failed')
    assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
  } finally { fault?.restore(); Date.now = now; f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
})
await check('任务文件暂时缺失且租约未过期时等待恢复，正常执行一次', async () => {
  const f = await fixture()
  let execution: Promise<string> | undefined, hidden = false
  try {
    execution = f.run(); await bounded(f.started.promise)
    fs.renameSync(f.tasksFile, f.tasksFile + '.held'); hidden = true
    await pause()
    assert.equal(f.signal?.aborted, false); assert.equal(f.effects, 0)
    fs.renameSync(f.tasksFile + '.held', f.tasksFile); hidden = false
    f.gate.resolve(); await bounded(execution)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.equal(f.store.listTasks('audit')[0].status, 'done')
    assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'EFFECT\n')
  } finally { if (hidden) fs.renameSync(f.tasksFile + '.held', f.tasksFile); f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
})
for (const stage of ['start', 'tool'] as const) {
  await check(`续期失败并过期时中断 ${stage} 等待，迟到处理不产生写入`, async () => {
    const f = await fixture(stage), now = Date.now
    let execution: Promise<string> | undefined, fault: ReturnType<typeof heartbeatFault> | undefined
    try {
      execution = f.run(); await bounded(f.started.promise)
      const expiry = f.store.listTasks('audit')[0].leaseExpiresAt!
      fault = heartbeatFault(f, 'read'); Date.now = () => expiry + 1
      await pause()
      assert.equal(f.signal?.aborted, true)
      fault.restore(); await bounded(execution); f.gate.resolve(); await pause(20)
      assert.equal(f.models, stage === 'start' ? 0 : 1); assert.equal(f.effects, 0)
      assert(!fs.existsSync(f.effectsFile)); assert(!f.host.isBusy())
      assert.equal(f.store.listTasks('audit')[0].status, 'failed')
    } finally { fault?.restore(); Date.now = now; f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
  })
}
await check('正常持续续期保留同一租约，任务和真实写入只完成一次', async () => {
  const f = await fixture()
  let execution: Promise<string> | undefined
  try {
    execution = f.run(); await bounded(f.started.promise)
    const first = f.store.listTasks('audit')[0]
    await pause()
    const renewed = f.store.listTasks('audit')[0]
    assert.equal(renewed.leaseId, first.leaseId); assert(renewed.leaseExpiresAt! > first.leaseExpiresAt!)
    assert.equal(f.signal?.aborted, false)
    f.gate.resolve(); await bounded(execution)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.equal(f.store.listTasks('audit')[0].status, 'done'); assert.equal(f.store.listTasks('audit')[0].attempt, 1)
    assert.equal(f.mail.read('captain').filter((message) => message.kind === 'task_result').length, 1)
    assert.deepEqual(f.store.loadTaskSettlements('audit'), [])
  } finally { f.gate.resolve(); await f.close(); await Promise.allSettled([execution]) }
})
console.log(`心跳有效期: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
