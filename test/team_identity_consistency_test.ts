import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import type { TeamMember } from '../src/team/types.ts'
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
    if (Date.now() >= end) throw new Error('团队身份一致性验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture() {
  let models = 0, effects = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    models++
    if (messages.at(-1)?.role !== 'tool') yield { type: 'tool_call', id: 'identity-write-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'ACTUAL-IDENTITY-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), peer = new TeamGroupStore(root), effectsFile = join(f.root, 'effects.log')
  const identities: (string | undefined)[] = [], managers: TeamManager[] = []
  const resources: { gate: ReturnType<typeof deferred>; creates: string[]; attaches: string[]; released: string[]; removed: string[] }[] = []
  f.registry.register({ name: 'write_file', description: '真实唯一身份写入', parameters: { type: 'object' }, async execute(_args, ctx) {
    effects++; identities.push(ctx.agentId); fs.appendFileSync(effectsFile, 'ACTUAL-IDENTITY-EFFECT\n')
    return { success: true, output: 'ACTUAL-IDENTITY-EFFECT' }
  } })
  const manager = (delayed = false) => {
    const id = managers.length, worktreeRoot = join(f.root, 'worktrees-' + id), gate = deferred(), started = deferred()
    const creates: string[] = [], attaches: string[] = [], released: string[] = [], removed: string[] = []
    fs.mkdirSync(worktreeRoot); if (!delayed) gate.resolve()
    const worktrees = {
      getRoot: () => worktreeRoot,
      create: async (name: string) => {
        creates.push(name); started.resolve(); await gate.promise
        const path = join(worktreeRoot, name); fs.mkdirSync(path, { recursive: true })
        return { name, path, created: true }
      },
      attach: async (name: string, path: string) => { attaches.push(name); started.resolve(); await gate.promise; return { name, path } },
      remove: async (name: string) => { removed.push(name); return '已删除 worktree: ' + name },
      release: (name: string) => { released.push(name) },
    }
    const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() }, worktrees as never)
    managers.push(team); resources.push({ gate, creates, attaches, released, removed })
    return { team, gate, started, creates, attaches, released, removed, worktreeRoot }
  }
  const member = (name: string, agentId?: string): TeamMember => ({ name, agentId, role: 'worker', workdir: f.root, backend: 'coroutine', needsApproval: false, status: 'idle' })
  return { ...f, root, peer, provider, manager, member, effectsFile, identities,
    get models() { return models }, get effects() { return effects },
    async close() { for (const resource of resources) resource.gate.resolve(); for (const team of managers) await team.close(1000); await f.close() },
  }
}

for (const conflict of ['name', 'same-group-agent', 'cross-group-agent', 'offline-name'] as const) await check('跨管理器持久化 ' + conflict + ' 冲突在创建资源前拒绝，不篡改原成员', async () => {
  const f = await fixture(), first = f.manager(), second = f.manager()
  try {
    const a = first.team.createGroup('first', 'lead-a'), b = first.team.createGroup('second', 'lead-b')
    await first.team.spawnMember(a, 'alice', 'worker', { agentId: 'shared-agent', roleDefinition: null })
    if (conflict === 'offline-name') { await first.team.close(0); f.peer.mutateGroup('first', (group) => { group.members[0].status = 'offline' }) }
    const expected = f.peer.loadGroup('first')!
    await assert.rejects(second.team.spawnMember(conflict === 'same-group-agent' ? f.peer.loadGroup('first')! : b,
      conflict === 'name' || conflict === 'offline-name' ? 'alice' : 'bob', 'worker', {
        agentId: conflict === 'name' || conflict === 'offline-name' ? 'different-agent' : 'shared-agent', roleDefinition: null,
      }))
    assert.deepEqual(second.creates, []); assert.equal(second.team.getMember('alice'), undefined); assert.equal(second.team.getMember('bob'), undefined)
    assert.deepEqual(f.peer.loadGroup('first'), expected); assert.deepEqual(f.peer.loadGroup('second')!.members, [])
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

for (const conflict of ['agent', 'name'] as const) await check('两个管理器等待资源后并发提交 ' + conflict + '，只有一个身份生效并实际写入一次', async () => {
  const f = await fixture(), a = f.manager(true), b = f.manager(true)
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
  try {
    const first = a.team.createGroup('first', 'lead-a'), second = a.team.createGroup('second', 'lead-b')
    const firstInit = a.team.spawnMember(first, 'alice', 'worker', { agentId: 'shared-agent', roleDefinition: null })
    const secondInit = b.team.spawnMember(second, conflict === 'name' ? 'alice' : 'bob', 'worker', { agentId: conflict === 'name' ? 'other-agent' : 'shared-agent', roleDefinition: null })
    pending = Promise.allSettled([firstInit, secondInit]); await bounded(Promise.all([a.started.promise, b.started.promise]))
    a.gate.resolve(); b.gate.resolve(); const outcomes = await bounded(pending)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const groups = ['first', 'second'].map((name) => f.peer.loadGroup(name)!), group = groups.find((current) => current.members.length)!
    assert.equal(groups.reduce((count, current) => count + current.members.length, 0), 1)
    const winner = group.name === 'first' ? a : b, loser = winner === a ? b : a, member = group.members[0]
    const loserName = loser === a || conflict === 'name' ? 'alice' : 'bob'
    assert(winner.team.getMember(member.name)?.matchesMember(member)); assert.equal(loser.team.getMember(loserName), undefined)
    assert.equal(loser.removed.length, 1); assert.equal(loser.released.length, 1)
    const task = winner.team.addTask(group.name, 'ONLY-UNIQUE-IDENTITY-WORK', member.name)
    await bounded(winner.team.runTask(group, task, member.name))
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.peer.listTasks(group.name)[0].attempt, 1)
  } finally { a.gate.resolve(); b.gate.resolve(); await pending; await f.close() }
})

for (const conflict of ['agent', 'name', 'case'] as const) await check('初始化等待期间其他小组新增 ' + conflict + ' 冲突，提交时重新核对并回滚本次资源', async () => {
  const f = await fixture(), a = f.manager(true)
  let initialization: ReturnType<typeof a.team.spawnMember> | undefined
  try {
    const first = a.team.createGroup('first', 'lead-a'), other = a.team.createGroup('other', 'lead-b')
    initialization = a.team.spawnMember(first, 'alice', 'worker', { agentId: 'shared-agent', roleDefinition: null })
    const outcome = initialization.then(() => false, () => true); await bounded(a.started.promise)
    f.peer.addMember(other, f.member(conflict === 'agent' ? 'bob' : conflict === 'case' ? 'Alice' : 'alice', conflict === 'agent' ? 'shared-agent' : 'peer-agent'))
    const expected = f.peer.loadGroup('other')!
    a.gate.resolve(); assert.equal(await bounded(outcome), true)
    assert.equal(a.team.getMember('alice'), undefined); assert.deepEqual(f.peer.loadGroup('first')!.members, [])
    assert.deepEqual(f.peer.loadGroup('other'), expected); assert.deepEqual(a.removed, ['member-alice']); assert.deepEqual(a.released, ['member-alice'])
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { a.gate.resolve(); await initialization?.catch(() => {}); await f.close() }
})

for (const conflict of ['same-group-agent', 'cross-group-agent', 'name'] as const) await check('恢复旧花名册 ' + conflict + ' 冲突时跳过全部歧义身份，正常成员仍可执行', async () => {
  const f = await fixture(), a = f.manager()
  try {
    const first = a.team.createGroup('first', 'lead-a'), second = a.team.createGroup('second', 'lead-b')
    f.peer.addMember(first, f.member('alice', 'shared-agent'))
    f.peer.addMember(conflict === 'same-group-agent' ? first : second,
      f.member(conflict === 'name' ? 'alice' : 'bob', conflict === 'name' ? 'other-agent' : 'shared-agent'))
    f.peer.addMember(second, f.member('carol', 'carol-agent'))
    assert.deepEqual(await bounded(a.team.restore([])), ['second/carol'])
    assert.equal(a.team.getMember('alice'), undefined); assert.equal(a.team.getMember('bob'), undefined)
    assert.equal(a.team.resolveMember({ cwd: f.root, agentId: 'shared-agent' }), null)
    const group = f.peer.loadGroup('second')!, task = a.team.addTask('second', 'VALID-RECOVERY-WORK', 'carol')
    await bounded(a.team.runTask(group, task, 'carol')); assert.equal(f.effects, 1); assert.deepEqual(f.identities, ['carol-agent'])
    assert.equal(f.peer.listTasks('second')[0].attempt, 1)
  } finally { await f.close() }
})

await check('已驻留成员出现持久化身份歧义，恢复关闭旧宿主并保留未执行任务次数', async () => {
  const f = await fixture(), a = f.manager()
  try {
    const first = a.team.createGroup('first', 'lead-a'), second = a.team.createGroup('second', 'lead-b')
    const old = await a.team.spawnMember(first, 'alice', 'worker', { agentId: 'shared-agent', roleDefinition: null })
    const task = a.team.addTask('first', 'AMBIGUOUS-IDENTITY-NO-WORK', 'alice')
    f.peer.addMember(second, f.member('bob', 'shared-agent'))
    assert.deepEqual(await bounded(a.team.restore([])), []); assert.equal(a.team.getMember('alice'), undefined)
    assert(!old.matchesMember(f.peer.loadGroup('first')!.members[0])); assert.equal(a.team.resolveMember({ cwd: f.root, agentId: 'shared-agent' }), null)
    await bounded(a.team.runTask(f.peer.loadGroup('first')!, task, 'alice'))
    const current = f.peer.listTasks('first')[0]
    assert.equal(current.status, 'todo'); assert.equal(current.attempt, 0); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

await check('已驻留成员幂等派生时也核对最新跨小组身份，不误报歧义身份可用', async () => {
  const f = await fixture(), a = f.manager()
  try {
    const first = a.team.createGroup('first', 'lead-a'), second = a.team.createGroup('second', 'lead-b')
    await a.team.spawnMember(first, 'alice', 'worker', { agentId: 'shared-agent', roleDefinition: null })
    f.peer.addMember(second, f.member('bob', 'shared-agent'))
    await assert.rejects(a.team.spawnMember(f.peer.loadGroup('first')!, 'alice', 'worker', { roleDefinition: null }))
    assert.equal(a.creates.length, 1); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

for (const conflict of ['agent', 'name', 'case'] as const) await check('等待恢复时其他小组新增 ' + conflict + ' 冲突，批量提交只保留正常成员', async () => {
  const f = await fixture(), a = f.manager(true)
  let restoration: Promise<string[]> | undefined
  try {
    const first = a.team.createGroup('first', 'lead-a'), other = a.team.createGroup('other', 'lead-b')
    const workdir = join(a.worktreeRoot, 'member-alice'); fs.mkdirSync(workdir)
    const alice = { ...f.member('alice', 'shared-agent'), workdir }
    f.peer.addMembers(first, [alice, f.member('carol', 'carol-agent')])
    restoration = a.team.restore([]); await bounded(a.started.promise)
    f.peer.addMember(other, f.member(conflict === 'agent' ? 'bob' : conflict === 'case' ? 'Alice' : 'alice', conflict === 'agent' ? 'shared-agent' : 'peer-agent'))
    const expected = f.peer.loadGroup('other')!
    a.gate.resolve(); assert.deepEqual(await bounded(restoration), ['first/carol'])
    assert.equal(a.team.getMember('alice'), undefined); assert.deepEqual(a.attaches, ['member-alice']); assert.deepEqual(a.released, ['member-alice'])
    const group = f.peer.loadGroup('first')!
    assert.deepEqual(group.members.find((member) => member.name === 'alice'), alice); assert.deepEqual(f.peer.loadGroup('other'), expected)
    const task = a.team.addTask('first', 'NORMAL-RESTORED-IDENTITY', 'carol')
    await bounded(a.team.runTask(group, task, 'carol')); assert.equal(f.effects, 1); assert.deepEqual(f.identities, ['carol-agent'])
  } finally { a.gate.resolve(); await restoration?.catch(() => {}); await f.close() }
})

for (const conflict of ['agent', 'name'] as const) await check('真实进程交错提交 ' + conflict + ' 时共享身份锁，只有一个成员和一次实际任务写入', async () => {
  const f = await fixture(), children: ChildProcess[] = [], exits: Promise<void>[] = []
  const commitReady = join(f.root, 'commit-ready'), commitGate = join(f.root, 'commit-gate'), effects = join(f.root, 'process-effects.log')
  const markers = ['first', 'second'].map((id) => ({ id, ready: join(f.root, id + '-ready'), gate: join(f.root, id + '-gate'), result: join(f.root, id + '-result.json') }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    f.peer.createGroup('first', 'lead-a'); f.peer.createGroup('second', 'lead-b')
    const worker = `
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      import { join } from 'node:path'
      import { TeamManager } from ${JSON.stringify(new URL('../src/team/index.ts', import.meta.url).href)}
      import { ToolRegistry } from ${JSON.stringify(new URL('../src/tools/registry.ts', import.meta.url).href)}
      const [root, repo, id, name, agentId, ready, gate, result, commitReady, commitGate, effects] = process.argv.slice(1)
      fs.mkdirSync(repo, { recursive: true })
      const wait = async () => {
        const end = Date.now() + 6000
        while (!fs.existsSync(gate)) {
          if (Date.now() >= end) throw new Error('身份资源进程交错超时')
          await new Promise((done) => setTimeout(done, 10))
        }
      }
      const released = [], removed = []
      const worktrees = {
        getRoot: () => join(repo, 'worktrees'),
        create: async (name) => {
          fs.writeFileSync(ready, 'resource-ready'); await wait()
          const path = join(repo, 'worktrees', name); fs.mkdirSync(path, { recursive: true })
          return { name, path, created: true }
        },
        remove: async (name) => { removed.push(name); return '已删除 worktree: ' + name },
        release: (name) => { released.push(name) },
      }
      const provider = { protocol: 'openai', async *streamChat(messages) {
        if (messages.at(-1)?.role !== 'tool') yield { type: 'tool_call', id: 'identity-write', name: 'write_file', arguments: {} }
        else { yield { type: 'text', text: 'PROCESS-IDENTITY-DONE' }; yield { type: 'done' } }
      } }
      const registry = new ToolRegistry()
      registry.register({ name: 'write_file', description: '真实进程任务写入', parameters: { type: 'object' }, async execute(_args, ctx) {
        fs.appendFileSync(effects, id + ':' + ctx.agentId + '\\n'); return { success: true, output: 'PROCESS-IDENTITY-EFFECT' }
      } })
      const team = new TeamManager(root, repo, { provider, registry, ctx: { cwd: repo, agentId: 'lead-' + id, sessionId: id } }, worktrees)
      const group = team.loadGroup(id), file = join(root, id, 'group.yaml'), rename = fs.renameSync
      let paused = false
      fs.renameSync = (source, destination) => {
        if (id === 'first' && !paused && String(destination) === file) {
          paused = true; fs.writeFileSync(commitReady, 'publication-locked')
          const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 6000
          while (!fs.existsSync(commitGate)) {
            if (Date.now() >= end) throw new Error('身份提交进程交错超时')
            Atomics.wait(sleep, 0, 0, 2)
          }
        }
        return rename(source, destination)
      }
      syncBuiltinESMExports()
      const outcome = { accepted: false, error: '', task: undefined, released, removed }
      try {
        await team.spawnMember(group, name, 'worker', { agentId, roleDefinition: null }); outcome.accepted = true
        const task = team.addTask(id, 'PROCESS-UNIQUE-IDENTITY-WORK', name)
        await team.runTask(group, task, name); outcome.task = team.listTasks(id)[0]
      } catch (error) { outcome.error = error.message }
      finally { fs.renameSync = rename; syncBuiltinESMExports(); await team.close(1000) }
      fs.writeFileSync(result, JSON.stringify(outcome))
    `
    for (const marker of markers) {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.root, join(f.root, 'repo-' + marker.id),
        marker.id, marker.id === 'first' || conflict === 'name' ? 'alice' : 'bob', marker.id === 'first' || conflict === 'agent' ? 'shared-agent' : 'other-agent',
        marker.ready, marker.gate, marker.result, commitReady, commitGate, effects], {
        cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      })
      children.push(child); let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`身份交错子进程失败 (${code}): ${stderr}`)))
      })
      void exited.catch(() => {}); exits.push(exited)
    }
    timer = setTimeout(() => { for (const child of children) child.kill() }, 10000)
    await waitUntil(() => markers.every((marker) => fs.existsSync(marker.ready)))
    fs.writeFileSync(markers[0].gate, 'go'); await waitUntil(() => fs.existsSync(commitReady))
    const identityLock = join(f.root, '_shared', 'members.lock')
    assert(JSON.parse(fs.readFileSync(identityLock, 'utf8')).owner.startsWith(children[0].pid + '-'))
    fs.writeFileSync(markers[1].gate, 'go'); await waitUntil(() => fs.existsSync(identityLock + '.queue'))
    assert(!fs.existsSync(markers[1].result)); fs.writeFileSync(commitGate, 'commit')
    await bounded(Promise.all(exits))
    const outcomes = markers.map((marker) => JSON.parse(fs.readFileSync(marker.result, 'utf8')))
    assert.equal(outcomes[0].accepted, true); assert.equal(outcomes[1].accepted, false)
    assert.match(outcomes[1].error, conflict === 'agent' ? /Agent ID.*已属于/ : /成员名.*已属于/)
    assert.equal(outcomes[0].task.status, 'done'); assert.equal(outcomes[0].task.attempt, 1)
    assert.equal(outcomes[1].removed.length, 1); assert.equal(outcomes[1].released.length, 1)
    assert.deepEqual(fs.readFileSync(effects, 'utf8').trim().split('\n'), ['first:shared-agent'])
    assert.equal(f.peer.loadGroup('first')!.members.length, 1); assert.deepEqual(f.peer.loadGroup('second')!.members, [])
    assert(!fs.existsSync(identityLock)); assert(!fs.existsSync(identityLock + '.queue'))
  } finally {
    for (const marker of markers) fs.writeFileSync(marker.gate, 'go')
    fs.writeFileSync(commitGate, 'commit'); clearTimeout(timer)
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.allSettled(exits); await f.close()
  }
})

await check('既有目录后来出现花名册，恢复刷新小组发现并执行新成员', async () => {
  const f = await fixture(), a = f.manager()
  try {
    a.team.createGroup('first', 'lead-a'); fs.mkdirSync(join(f.root, 'late'))
    assert.deepEqual(a.team.listGroups(), ['first'])
    f.peer.saveGroup({ name: 'late', lead: 'lead-b', members: [f.member('carol', 'carol-agent')] })
    assert.deepEqual(await bounded(a.team.restore([])), ['late/carol'])
    const group = f.peer.loadGroup('late')!, task = a.team.addTask('late', 'NEW-GROUP-DISCOVERY-WORK', 'carol')
    assert(a.team.getMember('carol')?.matchesMember(group.members[0]))
    await bounded(a.team.runTask(group, task, 'carol')); assert.equal(f.effects, 1); assert.deepEqual(f.identities, ['carol-agent'])
  } finally { await f.close() }
})

console.log(`\n团队身份一致性: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
