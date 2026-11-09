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
import type { TeamTask } from '../src/team/types.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('成员绑定验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(modelGate?: Promise<void>) {
  let models = 0, effects = 0
  const agents: (string | undefined)[] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++
    if (modelGate) {
      await resolveOnAbort(modelGate, options.signal, undefined)
      if (options.signal?.aborted) return
    }
    if (models % 2 === 1) yield { type: 'tool_call', id: 'binding-write-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'ACTUAL-BINDING-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root), peer = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const group = team.createGroup('audit', 'lead')
  const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
  const members = new Map<string, MemberHost>([['alice', host]]), memberGroups = new Map([['alice', group.name]])
  const scheduler = new TeamTaskScheduler({ store, mail: new TeamMail(join(root, '_shared', 'mail')), members, memberGroups,
    ctx: f.chat.getToolContext(), leaseMs: 60000, leaseHeartbeatMs: 30000 })
  const effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute(_args, ctx) {
    effects++; agents.push(ctx.agentId); fs.appendFileSync(effectsFile, 'ACTUAL-EFFECT\n'); return { success: true, output: 'ACTUAL-EFFECT' }
  } })
  return { ...f, teamRoot: root, store, peer, team, group, host, members, memberGroups, scheduler, effectsFile, agents,
    get models() { return models }, get effects() { return effects },
    async close() { await scheduler.close(1000); await team.close(1000); await f.close() },
  }
}

for (const timing of ['派发前', '领取前'] as const) for (const field of ['agentId', 'removed', 'offline', 'needsApproval', 'workdir', 'role'] as const) await check(timing + '花名册变更 ' + field + '，旧驻留成员不领取或执行', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    const _task = f.scheduler.addTask(f.group.name, 'STALE-MEMBER-BINDING', 'alice', [], 2)
    const change = () => f.peer.mutateGroup(f.group.name, (group) => {
      if (field === 'removed') { group.members = []; return }
      const member = group.members[0]
      if (field === 'agentId') member.agentId = 'replacement-agent'
      if (field === 'offline') member.status = 'offline'
      if (field === 'needsApproval') member.needsApproval = true
      if (field === 'workdir') member.workdir = join(f.root, 'replacement-workdir')
      if (field === 'role') member.role = 'replacement-role'
    })
    let injected = timing === '派发前'
    if (injected) change()
    else f.store.claimTask = (name, id, patch, guard) => {
      if (!injected) { injected = true; change() }
      return claim(name, id, patch, guard)
    }
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [])
    assert(injected)
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'todo'); assert.equal(current.attempt, 0)
    assert.equal(current.leaseId, undefined); assert.equal(current.activeAgentId, undefined)
    assert.equal(f.models, 0); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert(!f.host.isBusy()); assert.equal(f.team.readLeadMail().length, 0)
  } finally { f.store.claimTask = claim; await f.close() }
})

await check('调用方保留旧花名册时，同名成员换 Agent 也不执行旧模型', async () => {
  const f = await fixture()
  try {
    const task = f.scheduler.addTask(f.group.name, 'STALE-GROUP', 'alice')
    const oldAgent = f.group.members[0].agentId
    f.peer.mutateGroup(f.group.name, (group) => { group.members[0].agentId = 'replacement-agent' })
    await bounded(f.scheduler.runTask(f.group, task, 'alice'))
    assert.equal(f.group.members[0].agentId, oldAgent)
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].activeAgentId, undefined)
  } finally { await f.close() }
})

await check('驻留成员已关闭时，不消耗任务执行次数或写入假失败', async () => {
  const f = await fixture()
  try {
    const task = f.scheduler.addTask(f.group.name, 'CLOSED-HOST', 'alice')
    f.host.close()
    await bounded(f.scheduler.runTask(f.group, task, 'alice'))
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 0)
    assert.equal(f.team.readLeadMail().length, 0)
  } finally { await f.close() }
})

await check('花名册读取失败时保持任务和次数，读取恢复后由正确成员执行一次', async () => {
  const f = await fixture(), original = fs.statSync
  const file = join(f.teamRoot, 'audit', 'group.yaml')
  let blocked = false
  try {
    const task = f.scheduler.addTask(f.group.name, 'ROSTER-READ-FAILURE', 'alice')
    fs.statSync = ((path, options) => {
      if (blocked && String(path) === file) throw Object.assign(new Error('BINDING-READ-EACCES'), { code: 'EACCES' })
      return original(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports(); blocked = true
    await assert.rejects(f.scheduler.runTask(f.group, task, 'alice'), /BINDING-READ-EACCES/)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 0)
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    blocked = false
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /ACTUAL-BINDING-DONE/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.deepEqual(f.agents, [f.group.members[0].agentId])
  } finally { blocked = false; fs.statSync = original; syncBuiltinESMExports(); await f.close() }
})

await check('状态时间戳、其他成员或负责人变化，不阻止身份配置相同的成员执行', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    const task = f.scheduler.addTask(f.group.name, 'SAME-MEMBER-BINDING', 'alice')
    let injected = false
    f.store.claimTask = (name, id, patch, guard) => {
      if (!injected) {
        injected = true
        f.peer.mutateGroup(name, (group) => {
          group.lead = 'new-lead'; group.members[0].status = 'busy'; group.members[0].updatedAt = Date.now()
          group.members.push({ ...group.members[0], name: 'bob', agentId: 'agent-bob', status: 'idle' })
        })
      }
      return claim(name, id, patch, guard)
    }
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /ACTUAL-BINDING-DONE/)
    assert(injected); assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.deepEqual(f.agents, [f.group.members[0].agentId])
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done')
  } finally { f.store.claimTask = claim; await f.close() }
})

await check('恢复后已换成新驻留成员，即使调用方花名册过期也按真实 Agent 执行', async () => {
  const f = await fixture()
  let replacement: TeamManager | undefined
  try {
    const task = f.scheduler.addTask(f.group.name, 'RESTORED-BINDING', 'alice')
    const oldAgent = f.group.members[0].agentId
    f.host.close()
    let calls = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++calls === 1) yield { type: 'tool_call', id: 'restored-write', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'RESTORED-WORK-DONE' }; yield { type: 'done' } }
    } }
    replacement = new TeamManager(f.teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const currentGroup = f.peer.loadGroup(f.group.name)!
    const host = await replacement.spawnMember(currentGroup, 'alice', 'worker', { workdir: f.root, roleDefinition: null, agentId: 'replacement-agent' })
    f.members.set('alice', host)
    assert.equal(f.group.members[0].agentId, oldAgent)
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /RESTORED-WORK-DONE/)
    assert.equal(calls, 2); assert.equal(f.effects, 1)
    assert.deepEqual(f.agents, ['replacement-agent'])
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'done'); assert.equal(current.attempt, 1)
    assert.equal(current.reportId, f.peer.listTasks(f.group.name)[0].reportId)
  } finally { await replacement?.close(1000); await f.close() }
})

await check('真实进程在领取提交期间替换花名册，修改等待领取完成且旧执行不写入', async () => {
  const modelGate = deferred(), f = await fixture(modelGate.promise), original = fs.renameSync
  const ready = join(f.root, 'ready'), gate = join(f.root, 'gate'), finished = join(f.root, 'finished')
  const file = join(f.teamRoot, 'audit', 'tasks.json'), identityLock = join(f.teamRoot, '_shared', 'members.lock'), queue = identityLock + '.queue'
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, ready, gate, finished] = process.argv.slice(1)
      writeFileSync(ready, 'ready')
      const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
      while (!existsSync(gate)) {
        if (Date.now() >= end) throw new Error('花名册进程交错启动超时')
        Atomics.wait(wait, 0, 0, 2)
      }
      new TeamGroupStore(root).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
      writeFileSync(finished, 'finished')
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, ready, gate, finished], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`花名册更新子进程失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {})
    timer = setTimeout(() => child?.kill(), 8000)
    await waitUntil(() => fs.existsSync(ready))
    const task = f.scheduler.addTask(f.group.name, 'ROSTER-COMMIT-RACE', 'alice')
    let interleaved = false
    fs.renameSync = ((source, destination) => {
      if (!interleaved && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((item: TeamTask) => item.status === 'in_progress')) {
        assert(fs.existsSync(join(f.teamRoot, 'audit', 'group.lock')))
        assert(JSON.parse(fs.readFileSync(join(f.teamRoot, 'audit', 'group.lock'), 'utf8')).owner.startsWith(process.pid + '-'))
        assert(JSON.parse(fs.readFileSync(identityLock, 'utf8')).owner.startsWith(process.pid + '-'))
        interleaved = true; fs.writeFileSync(gate, 'go')
        const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 3000
        while (!fs.existsSync(queue) && !fs.existsSync(finished)) {
          if (Date.now() >= end) throw new Error('花名册锁交错超时')
          Atomics.wait(wait, 0, 0, 2)
        }
        assert(!fs.existsSync(finished))
        assert.equal(f.peer.loadGroup(f.group.name)!.members[0].agentId, f.group.members[0].agentId)
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    const execution = f.scheduler.runTask(f.group, task, 'alice')
    await bounded(execution)
    assert(interleaved); await bounded(exited)
    assert.equal(f.peer.loadGroup(f.group.name)!.members[0].agentId, 'replacement-agent')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'failed')
    assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert(!fs.existsSync(join(f.teamRoot, 'audit', 'group.lock'))); assert(!fs.existsSync(identityLock)); assert(!fs.existsSync(queue))
  } finally {
    modelGate.resolve(); fs.renameSync = original; syncBuiltinESMExports(); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

console.log(`\n团队成员绑定: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
