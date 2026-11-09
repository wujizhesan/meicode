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
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('执行中成员绑定恢复超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(stage: 'model' | 'start' | 'approval' | 'tool' | 'none' | 'finished' | 'late-text' | 'late-result' = 'model') {
  const started = deferred(), gate = deferred(), hooks = new HookEngine([])
  let models = 0, effects = 0, signal: AbortSignal | undefined
  hooks.fire = async (event, _payload, currentSignal) => {
    if ((stage === 'start' && event === 'subagent_start') || (stage === 'finished' && event === 'subagent_stop')) {
      signal = currentSignal; started.resolve(); await gate.promise
    }
  }
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (stage === 'late-text' || (stage === 'late-result' && models === 2)) {
      new TeamGroupStore(root).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
      yield { type: 'text', text: 'STALE-FINAL-TEXT' }; yield { type: 'done' }; return
    }
    if (models === 1) {
      if (stage === 'model') {
        signal = options.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
        if (signal?.aborted) return
      }
      yield { type: 'tool_call', id: 'binding-effect', name: 'write_file', arguments: {} }
    } else { yield { type: 'text', text: 'REAL-BINDING-COMPLETED' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider, { hooks }), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const group = team.createGroup('audit', 'lead')
  const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null, needsApproval: stage === 'approval' })
  const effectsFile = join(f.root, 'effects.log'), mail = new TeamMail(join(root, '_shared', 'mail'))
  f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute(_args, ctx) {
    if (stage === 'tool') {
      signal = ctx.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined)
      if (signal?.aborted) return { success: false, output: '', error: '已取消' }
    }
    effects++; fs.appendFileSync(effectsFile, 'REAL-EFFECT\n'); return { success: true, output: 'REAL-EFFECT' }
  } })
  const task = team.addTask(group.name, 'BINDING-IN-EXECUTION', 'alice')
  return { ...f, teamRoot: root, store, team, group, host, task, mail, hooks, started, gate, effectsFile,
    get models() { return models }, get effects() { return effects }, get signal() { return signal },
    async start() {
      const execution = team.runTask(group, task, 'alice')
      if (stage === 'approval') await waitUntil(() => team.readLeadMail().some((message) => message.kind === 'approval_plan'))
      else if (stage !== 'none') await bounded(started.promise)
      return { execution }
    },
    async close() { gate.resolve(); await team.close(1000); await f.close() },
  }
}

for (const field of ['agentId', 'removed', 'offline', 'needsApproval', 'workdir', 'role'] as const) await check('等待模型时成员 ' + field + ' 变化，停止旧执行且不写文件或误报成功', async () => {
  const f = await fixture(), peer = new TeamGroupStore(f.teamRoot)
  let execution: Promise<string> | undefined
  try {
    execution = (await f.start()).execution
    peer.mutateGroup(f.group.name, (group) => {
      if (field === 'removed') { group.members = []; return }
      const member = group.members[0]
      if (field === 'agentId') member.agentId = 'replacement-agent'
      if (field === 'offline') member.status = 'offline'
      if (field === 'needsApproval') member.needsApproval = true
      if (field === 'workdir') member.workdir = join(f.root, 'replacement-workdir')
      if (field === 'role') member.role = 'replacement-role'
    })
    await bounded(execution)
    assert.equal(f.signal?.aborted, true); assert.equal(f.models, 1); assert.equal(f.effects, 0)
    assert(!fs.existsSync(f.effectsFile)); assert(!f.host.isBusy())
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'failed'); assert.equal(current.attempt, 1)
    assert.equal(current.leaseId, undefined); assert.equal(current.report?.status, 'failed')
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
  } finally { await f.close(); await Promise.allSettled([execution]) }
})

await check('花名册忙碌状态和更新时间变化不影响同一成员，正常完成且只写入一次', async () => {
  const f = await fixture()
  let execution: Promise<string> | undefined
  try {
    execution = (await f.start()).execution
    new TeamGroupStore(f.teamRoot).mutateGroup(f.group.name, (group) => {
      group.members[0].status = 'busy'; group.members[0].updatedAt = Date.now() + 1000
    })
    await new Promise((done) => setTimeout(done, 650))
    assert.equal(f.signal?.aborted, false)
    f.gate.resolve(); assert.match(await bounded(execution), /REAL-BINDING-COMPLETED/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'REAL-EFFECT\n')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
  } finally { await f.close(); await Promise.allSettled([execution]) }
})

for (const stage of ['start', 'approval', 'tool'] as const) await check('成员替换中断 ' + stage + ' 等待，迟到 Hook/审批/工具不继续执行', async () => {
  const f = await fixture(stage)
  let execution: Promise<string> | undefined
  try {
    execution = (await f.start()).execution
    const plan = f.team.readLeadMail().find((message) => message.kind === 'approval_plan')
    new TeamGroupStore(f.teamRoot).mutateGroup(f.group.name, (group) => { group.members[0].agentId = 'replacement-agent' })
    await bounded(execution)
    if (plan) f.mail.send('lead', 'alice', 'APPROVE', { groupId: f.group.name, kind: 'approval_decision', taskId: f.task.id, correlationId: plan.correlationId })
    else assert.equal(f.signal?.aborted, true)
    f.gate.resolve()
    assert.equal(f.models, stage === 'tool' ? 1 : 0); assert.equal(f.effects, 0)
    assert(!fs.existsSync(f.effectsFile)); assert(!f.host.isBusy())
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'failed')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
  } finally { await f.close(); await Promise.allSettled([execution]) }
})

for (const stage of ['start', 'pre-tool'] as const) await check(stage + ' Hook 当场替换成员，无需等轮询便阻止下一次模型或工具调用', async () => {
  const f = await fixture('none')
  try {
    let changed = false
    const replace = () => {
      if (!changed) { changed = true; new TeamGroupStore(f.teamRoot).mutateGroup(f.group.name, (group) => { group.members[0].agentId = 'replacement-agent' }) }
    }
    if (stage === 'start') f.hooks.fire = async (event) => { if (event === 'subagent_start') replace() }
    else f.hooks.intercept = async () => { replace(); return null }
    await bounded(f.team.runTask(f.group, f.task, 'alice'))
    assert(changed); assert.equal(f.models, stage === 'start' ? 0 : 1)
    assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'failed')
  } finally { await f.close() }
})

await check('已执行一轮后成员替换，保留既有写入但不调用下一轮模型', async () => {
  const f = await fixture('none')
  try {
    let changed = false
    f.hooks.fire = async (event, payload) => {
      if (event === 'round_start' && payload.round === 2 && !changed) {
        changed = true; new TeamGroupStore(f.teamRoot).mutateGroup(f.group.name, (group) => { group.members[0].role = 'replacement-role' })
      }
    }
    await bounded(f.team.runTask(f.group, f.task, 'alice'))
    assert(changed); assert.equal(f.models, 1); assert.equal(f.effects, 1)
    assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'REAL-EFFECT\n')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'failed')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
  } finally { await f.close() }
})

for (const stage of ['late-text', 'late-result'] as const) await check(stage + ' 成员替换与最终文本同时到达，保留既有写入但不接受旧身份结果', async () => {
  const f = await fixture(stage)
  try {
    await bounded(f.team.runTask(f.group, f.task, 'alice'))
    assert.equal(f.models, stage === 'late-text' ? 1 : 2)
    assert.equal(f.effects, stage === 'late-text' ? 0 : 1)
    if (stage === 'late-text') assert(!fs.existsSync(f.effectsFile))
    else assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'REAL-EFFECT\n')
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'failed'); assert.equal(current.attempt, 1)
    assert.equal(current.report?.status, 'failed'); assert.notEqual(current.result, 'STALE-FINAL-TEXT')
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
    assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
  } finally { await f.close() }
})

for (const recovery of ['same', 'replaced', 'close'] as const) await check('执行边界花名册读取失败 ' + recovery + '，等待可信状态且可恢复或关闭', async () => {
  const f = await fixture(), original = fs.statSync, groupFile = join(f.teamRoot, 'audit', 'group.yaml')
  let execution: Promise<string> | undefined, blocked = false, reads = 0
  try {
    execution = (await f.start()).execution
    fs.statSync = ((path, options) => {
      if (blocked && String(path) === groupFile) { reads++; throw Object.assign(new Error('EXECUTION-ROSTER-EACCES'), { code: 'EACCES' }) }
      return original(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports(); blocked = true; f.gate.resolve()
    await waitUntil(() => reads >= 2)
    assert.equal(f.models, 1); assert.equal(f.effects, 0); assert.equal(f.signal?.aborted, false)
    if (recovery === 'replaced') new TeamGroupStore(f.teamRoot).mutateGroup(f.group.name, (group) => { group.members[0].agentId = 'replacement-agent' })
    if (recovery === 'close') await bounded(f.team.close(1000))
    blocked = false; await bounded(execution)
    if (recovery === 'close') f.team.listTasks(f.group.name)
    const current = f.store.listTasks(f.group.name)[0]
    if (recovery === 'same') {
      assert.equal(current.status, 'done'); assert.equal(current.attempt, 1)
      assert.equal(f.models, 2); assert.equal(f.effects, 1)
      assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'REAL-EFFECT\n')
    } else {
      assert.notEqual(current.status, 'done'); assert.equal(f.models, 1); assert.equal(f.effects, 0)
      assert(!fs.existsSync(f.effectsFile)); assert.equal(f.signal?.aborted, true)
    }
    assert(!f.host.isBusy()); assert.deepEqual(f.store.loadTaskSettlements(f.group.name), [])
  } finally { blocked = false; fs.statSync = original; syncBuiltinESMExports(); await f.close(); await Promise.allSettled([execution]) }
})

await check('真实工作已经完成后成员替换，等待收尾 Hook 仍保留原结果且不重跑', async () => {
  const f = await fixture('finished')
  let execution: Promise<string> | undefined
  try {
    execution = (await f.start()).execution
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    new TeamGroupStore(f.teamRoot).mutateGroup(f.group.name, (group) => { group.members[0].agentId = 'replacement-agent' })
    await new Promise((done) => setTimeout(done, 650))
    assert.equal(f.signal?.aborted, false)
    f.gate.resolve(); assert.match(await bounded(execution), /REAL-BINDING-COMPLETED/)
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'done'); assert.equal(current.attempt, 1)
    assert.equal(current.result, 'REAL-BINDING-COMPLETED'); assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'REAL-EFFECT\n')
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
  } finally { await f.close(); await Promise.allSettled([execution]) }
})

console.log(`\n执行中成员绑定: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
