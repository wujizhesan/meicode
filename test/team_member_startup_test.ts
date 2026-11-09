import './git-ceiling.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { createLeadTools } from '../src/team/lead-tools.ts'
import { WorktreeManager } from '../src/worktree/index.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function fixture(options: { reused?: boolean; removeFails?: boolean; removeThrows?: boolean } = {}) {
  const started = deferred(), gate = deferred(), created: string[] = [], removed: string[] = [], released: string[] = []
  let models = 0, effects = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    models++
    if (messages.at(-1)?.role !== 'tool') yield { type: 'tool_call', id: 'startup-write-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'ACTUAL-STARTUP-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), worktreeRoot = join(f.root, 'worktrees')
  fs.mkdirSync(worktreeRoot)
  const worktrees = {
    getRoot: () => worktreeRoot,
    create: async (name: string) => {
      created.push(name); started.resolve(); await gate.promise
      const path = join(worktreeRoot, name); fs.mkdirSync(path, { recursive: true })
      return { name, path, branch: 'wt-' + name, createdAt: Date.now(), dirty: false, created: !options.reused }
    },
    attach: async (name: string, path: string) => { created.push(name); started.resolve(); await gate.promise; return { name, path } },
    remove: async (name: string) => {
      removed.push(name)
      if (options.removeThrows) throw new Error('STARTUP-ROLLBACK-EIO')
      if (options.removeFails) return 'worktree 有未提交修改，拒绝删除'
      return '已删除 worktree: ' + name
    },
    release: (name: string) => { released.push(name) },
  }
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() }, worktrees as never)
  const group = team.createGroup('audit', 'lead'), peer = new TeamGroupStore(root), effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '真实初始化写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(effectsFile, 'ACTUAL-STARTUP-EFFECT\n'); return { success: true, output: 'ACTUAL-STARTUP-EFFECT' }
  } })
  return { ...f, team, group, peer, started, gate, created, removed, released, worktreeRoot, effectsFile,
    get models() { return models }, get effects() { return effects },
    async close() { gate.resolve(); await team.close(1000); await f.close() },
  }
}

await check('同组同名并发初始化共享一个宿主与 worktree，实际任务只写入一次', async () => {
  const f = await fixture()
  try {
    const first = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'one-agent', roleDefinition: null })
    await bounded(f.started.promise)
    const second = f.team.spawnMember(f.peer.loadGroup('audit')!, 'alice', 'worker', { agentId: 'one-agent', roleDefinition: null })
    const pending = Promise.all([first, second]); f.gate.resolve()
    const [a, b] = await bounded(pending)
    assert.equal(a, b); assert.deepEqual(f.created, ['member-alice']); assert.deepEqual(f.removed, [])
    assert.equal(f.peer.loadGroup('audit')!.members.length, 1)
    const task = f.team.addTask('audit', 'CONCURRENT-STARTUP-WORK', 'alice')
    await bounded(f.team.runTask(f.peer.loadGroup('audit')!, task, 'alice'))
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.peer.listTasks('audit')[0].attempt, 1)
  } finally { await f.close() }
})

for (const kind of ['group', 'case', 'agentId', 'role', 'approval', 'workdir'] as const) await check('并发初始化 ' + kind + ' 冲突在资源创建前拒绝，不覆盖正在准备的成员', async () => {
  const f = await fixture()
  let first: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    const other = f.team.createGroup('other', 'other-lead')
    first = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'one-agent', roleDefinition: null })
    await bounded(f.started.promise)
    const second = f.team.spawnMember(kind === 'group' ? other : f.group, kind === 'case' ? 'Alice' : 'alice', kind === 'role' ? 'different-role' : 'worker', {
      agentId: kind === 'agentId' ? 'other-agent' : 'one-agent', needsApproval: kind === 'approval', roleDefinition: null,
      ...(kind === 'workdir' ? { workdir: f.root } : {}),
    })
    const outcome = second.then(() => false, () => true)
    f.gate.resolve(); assert.equal(await bounded(outcome), true); await bounded(first)
    assert.deepEqual(f.created, ['member-alice']); assert.deepEqual(f.removed, [])
    assert.equal(f.peer.loadGroup('audit')!.members[0].agentId, 'one-agent')
    assert.equal(f.peer.loadGroup('audit')!.members[0].role, 'worker'); assert.equal(f.peer.loadGroup('audit')!.members[0].needsApproval, false)
    assert.deepEqual(f.peer.loadGroup('other')!.members, [])
  } finally { f.gate.resolve(); await Promise.allSettled([first]); await f.close() }
})

await check('不同成员并发使用同一个 Agent ID 时只准备一份资源，失败后身份仍唯一', async () => {
  const f = await fixture()
  let first: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    first = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'one-agent', roleDefinition: null })
    await bounded(f.started.promise)
    const second = f.team.spawnMember(f.group, 'bob', 'worker', { agentId: 'one-agent', roleDefinition: null })
    const outcome = second.then(() => false, () => true)
    f.gate.resolve(); assert.equal(await bounded(outcome), true); await bounded(first)
    assert.deepEqual(f.created, ['member-alice']); assert.equal(f.team.getMember('bob'), undefined)
    assert.equal(f.team.resolveMember({ cwd: f.root, agentId: 'one-agent' })?.member.name, 'alice')
  } finally { f.gate.resolve(); await Promise.allSettled([first]); await f.close() }
})

for (const field of ['added', 'agentId', 'role', 'approval', 'removed', 'lead'] as const) await check('初始化等待期间花名册 ' + field + ' 变化，旧提交不覆盖新版本', async () => {
  const f = await fixture()
  let initialization: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    if (field !== 'added' && field !== 'lead') f.peer.addMember(f.group, { name: 'alice', agentId: 'old-agent', role: 'worker', workdir: f.root, backend: 'coroutine', needsApproval: false, status: 'idle' })
    initialization = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'one-agent', roleDefinition: null })
    const outcome = initialization.then(() => false, () => true)
    await bounded(f.started.promise)
    f.peer.mutateGroup('audit', (group) => {
      if (field === 'added') group.members.push({ name: 'alice', agentId: 'peer-agent', role: 'worker', workdir: f.root, backend: 'coroutine', needsApproval: true, status: 'busy' })
      if (field === 'agentId') group.members[0].agentId = 'peer-agent'
      if (field === 'role') group.members[0].role = 'peer-role'
      if (field === 'approval') group.members[0].needsApproval = true
      if (field === 'removed') group.members = []
      if (field === 'lead') group.lead = 'peer-lead'
    })
    const expected = f.peer.loadGroup('audit')!
    f.gate.resolve(); assert.equal(await bounded(outcome), true)
    assert.deepEqual(f.peer.loadGroup('audit'), expected); assert.equal(f.team.getMember('alice'), undefined)
    assert.equal(f.models, 0); assert.equal(f.effects, 0); assert.deepEqual(f.removed, ['member-alice']); assert(f.released.includes('member-alice'))
  } finally { f.gate.resolve(); await Promise.allSettled([initialization]); await f.close() }
})

for (const reused of [true, false]) await check('关闭时回滚 ' + (reused ? '复用' : '新建') + ' worktree，保留旧产物并释放租约', async () => {
  const f = await fixture({ reused })
  let initialization: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    const artifact = join(f.worktreeRoot, 'member-alice', 'saved-artifact.txt')
    fs.mkdirSync(join(f.worktreeRoot, 'member-alice')); fs.writeFileSync(artifact, 'PRESERVED-USER-ARTIFACT')
    initialization = f.team.spawnMember(f.group, 'alice', 'worker', { roleDefinition: null })
    const outcome = initialization.then(() => false, () => true)
    await bounded(f.started.promise); await bounded(f.team.close(0)); f.gate.resolve()
    assert.equal(await bounded(outcome), true)
    assert.deepEqual(f.removed, reused ? [] : ['member-alice']); assert(f.released.includes('member-alice'))
    assert.equal(f.team.getMember('alice'), undefined); assert.deepEqual(f.peer.loadGroup('audit')!.members, [])
    if (reused) assert.equal(fs.readFileSync(artifact, 'utf8'), 'PRESERVED-USER-ARTIFACT')
  } finally { f.gate.resolve(); await Promise.allSettled([initialization]); await f.close() }
})

for (const throws of [false, true]) await check('新建资源回滚' + (throws ? '抛错' : '被拒绝') + '时仍释放租约，初始化占用可在后续重试释放', async () => {
  const f = await fixture({ removeFails: !throws, removeThrows: throws })
  let initialization: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    initialization = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'retry-agent', roleDefinition: null })
    const outcome = initialization.then(() => false, () => true)
    await bounded(f.started.promise)
    fs.writeFileSync(join(f.root, 'team', 'audit', 'group.yaml'), 'name: [BROKEN')
    f.gate.resolve(); assert.equal(await bounded(outcome), true)
    assert.deepEqual(f.removed, ['member-alice']); assert(f.released.includes('member-alice'))
    f.peer.saveGroup({ name: 'audit', lead: 'lead', members: [] })
    const host = await bounded(f.team.spawnMember(f.peer.loadGroup('audit')!, 'alice', 'worker', { agentId: 'retry-agent', roleDefinition: null }))
    assert(host.matchesMember(f.peer.loadGroup('audit')!.members[0])); assert.equal(f.created.length, 2)
  } finally { f.gate.resolve(); await Promise.allSettled([initialization]); await f.close() }
})

await check('已驻留成员的配置冲突不被 team_spawn 误报成新角色或审批配置已生效', async () => {
  const f = await fixture()
  try {
    f.gate.resolve(); const original = await f.team.spawnMember(f.group, 'alice', 'worker', { roleDefinition: null })
    const tool = createLeadTools(f.team).find((item) => item.name === 'team_spawn')!
    const result = await tool.execute({ group: 'audit', member: 'alice', role: 'different-role', needs_approval: true }, f.chat.getToolContext())
    assert.equal(result.success, false); assert.equal(f.team.getMember('alice'), original)
    assert.equal(f.peer.loadGroup('audit')!.members[0].role, 'worker'); assert.equal(f.peer.loadGroup('audit')!.members[0].needsApproval, false)
    assert.equal(f.created.length, 1); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

await check('未指定 Agent ID 的并发请求共享自动身份，后续同配置派生仍幂等', async () => {
  const f = await fixture()
  let first: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    first = f.team.spawnMember(f.group, 'alice', 'worker', { roleDefinition: null })
    await bounded(f.started.promise)
    const second = f.team.spawnMember(f.peer.loadGroup('audit')!, 'alice', 'worker', { roleDefinition: null })
    f.gate.resolve(); const [a, b] = await bounded(Promise.all([first, second]))
    assert.equal(a, b); assert.equal(f.created.length, 1)
    const group = f.peer.loadGroup('audit')!, member = group.members[0]
    assert(member.agentId); assert.equal(f.team.resolveMember({ cwd: member.workdir, agentId: member.agentId })?.member.name, 'alice')
    assert.equal(await f.team.spawnMember(group, 'alice', 'worker', { roleDefinition: null }), a)
    assert.equal(f.created.length, 1)
  } finally { f.gate.resolve(); await Promise.allSettled([first]); await f.close() }
})

await check('不同成员与身份可并发初始化，两次提交保留各自配置', async () => {
  const f = await fixture()
  let pending: Promise<unknown> | undefined
  try {
    const a = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
    const b = f.team.spawnMember(f.peer.loadGroup('audit')!, 'bob', 'worker', { agentId: 'bob-agent', roleDefinition: null })
    pending = Promise.all([a, b]); await bounded(f.started.promise)
    assert.deepEqual(f.created, ['member-alice', 'member-bob'])
    f.gate.resolve(); await bounded(pending)
    const group = f.peer.loadGroup('audit')!
    assert.equal(group.members.length, 2)
    for (const member of group.members) assert(f.team.getMember(member.name)?.matchesMember(member))
    assert.deepEqual(f.removed, [])
  } finally { f.gate.resolve(); await pending?.catch(() => {}); await f.close() }
})

for (const field of ['closed', 'offline', 'changed'] as const) await check('重复派生不返回 ' + field + ' 的旧驻留宿主，也不创建冲突资源', async () => {
  const f = await fixture()
  try {
    f.gate.resolve(); const original = await f.team.spawnMember(f.group, 'alice', 'worker', { roleDefinition: null })
    if (field === 'closed') original.close()
    else f.peer.mutateGroup('audit', (group) => {
      if (field === 'offline') group.members[0].status = 'offline'
      else group.members[0].agentId = 'replacement-agent'
    })
    const expected = f.peer.loadGroup('audit')!
    await assert.rejects(f.team.spawnMember(expected, 'alice', 'worker', { roleDefinition: null }))
    assert.deepEqual(f.peer.loadGroup('audit'), expected); assert.equal(f.created.length, 1)
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

await check('普通派生与恢复同一成员交错时不创建第二个宿主或覆盖未提交配置', async () => {
  const f = await fixture()
  let initialization: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    const workdir = join(f.worktreeRoot, 'member-alice'); fs.mkdirSync(workdir)
    f.peer.addMember(f.group, { name: 'alice', agentId: 'one-agent', role: 'worker', workdir, backend: 'coroutine', needsApproval: false, status: 'idle' })
    initialization = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'one-agent', workdir, roleDefinition: null })
    await bounded(f.started.promise)
    assert.deepEqual(await bounded(f.team.restore([])), []); assert.equal(f.created.length, 1)
    f.gate.resolve(); const original = await bounded(initialization)
    await bounded(f.team.restore([])); assert.equal(f.team.getMember('alice'), original); assert.equal(f.created.length, 1)
  } finally { f.gate.resolve(); await Promise.allSettled([initialization]); await f.close() }
})

await check('真实 Git 复用的干净 worktree 初始化失败后保留忽略产物、分支和目录，并释放租约', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), repo = join(f.root, 'git-repo'), root = join(f.root, 'real-team')
  fs.mkdirSync(repo)
  const git = (args: string[], cwd = repo) => {
    const result = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
  }
  let team: TeamManager | undefined, worktrees: WorktreeManager | undefined, probe: WorktreeManager | undefined
  const name = 'member-alice'
  try {
    git(['init', '-b', 'main']); fs.writeFileSync(join(repo, 'README.md'), 'ISOLATED-STARTUP-REPO\n')
    git(['add', 'README.md']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'])
    worktrees = new WorktreeManager(repo)
    const prior = await worktrees.create(name); assert.equal(prior.created, true)
    const artifacts = join(prior.path, '.meicode', 'artifacts'); fs.mkdirSync(artifacts, { recursive: true })
    const artifact = join(artifacts, 'saved.bin'); fs.writeFileSync(artifact, 'PRESERVED-IGNORED-ARTIFACT')
    assert.equal(git(['status', '--porcelain'], prior.path), ''); worktrees.release(name)
    team = new TeamManager(root, repo, { provider, registry: f.registry, ctx: f.chat.getToolContext() }, worktrees)
    const group = team.createGroup('audit', 'lead'), peer = new TeamGroupStore(root), create = worktrees.create.bind(worktrees)
    worktrees.create = async (requested) => {
      const reused = await create(requested); assert.equal(reused.created, false)
      peer.mutateGroup('audit', (current) => { current.lead = 'replacement-lead' })
      return reused
    }
    await assert.rejects(team.spawnMember(group, 'alice', 'worker', { roleDefinition: null }), /花名册已发生变化/)
    assert.equal(team.getMember('alice'), undefined); assert(fs.existsSync(prior.path))
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'PRESERVED-IGNORED-ARTIFACT')
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], prior.path), 'wt-member-alice')
    assert.equal(git(['status', '--porcelain'], prior.path), '')
    probe = new WorktreeManager(repo); assert.equal((await probe.attach(name, prior.path)).path, prior.path)
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'PRESERVED-IGNORED-ARTIFACT')
  } finally { probe?.release(name); worktrees?.release(name); await team?.close(1000); await f.close() }
})

await check('真实进程持花名册锁添加同名成员，初始化提交等待锁后核对当前版本并拒绝覆盖', async () => {
  const f = await fixture(), publish = TeamGroupStore.prototype.publishMember
  const ready = join(f.root, 'ready'), gate = join(f.root, 'gate'), finished = join(f.root, 'finished')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let initialization: ReturnType<typeof f.team.spawnMember> | undefined
  try {
    initialization = f.team.spawnMember(f.group, 'alice', 'worker', { agentId: 'one-agent', roleDefinition: null })
    const outcome = initialization.then(() => false, () => true); await bounded(f.started.promise)
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, ready, gate, finished, workdir] = process.argv.slice(1)
      new TeamGroupStore(root).mutateGroup('audit', (group) => {
        writeFileSync(ready, 'locked')
        const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
        while (!existsSync(gate)) {
          if (Date.now() >= end) throw new Error('初始化进程交错验证超时')
          Atomics.wait(wait, 0, 0, 2)
        }
        group.members.push({ name: 'alice', agentId: 'peer-agent', role: 'peer-role', workdir, backend: 'coroutine', needsApproval: true, status: 'busy' })
      })
      writeFileSync(finished, 'finished')
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, join(f.root, 'team'), ready, gate, finished, f.root], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`初始化更新子进程失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {}); timer = setTimeout(() => child?.kill(), 8000)
    await bounded((async () => { while (!fs.existsSync(ready)) await new Promise((done) => setTimeout(done, 10)) })())
    assert(JSON.parse(fs.readFileSync(join(f.root, 'team', 'audit', 'group.lock'), 'utf8')).owner.startsWith(child.pid + '-'))
    TeamGroupStore.prototype.publishMember = function (...args) { fs.writeFileSync(gate, 'go'); return publish.apply(this, args) }
    f.gate.resolve(); assert.equal(await bounded(outcome), true); await bounded(exited)
    assert(fs.existsSync(finished)); const member = f.peer.loadGroup('audit')!.members[0]
    assert.equal(member.agentId, 'peer-agent'); assert.equal(member.role, 'peer-role'); assert.equal(member.needsApproval, true)
    assert.equal(member.status, 'busy'); assert.equal(f.team.getMember('alice'), undefined)
    assert.equal(f.models, 0); assert.equal(f.effects, 0); assert.deepEqual(f.removed, ['member-alice'])
    assert(f.released.includes('member-alice')); assert(!fs.existsSync(join(f.root, 'team', 'audit', 'group.lock')))
    assert(!fs.existsSync(join(f.root, 'team', 'audit', 'group.lock.queue')))
  } finally {
    TeamGroupStore.prototype.publishMember = publish; fs.writeFileSync(gate, 'go'); f.gate.resolve(); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await Promise.allSettled([initialization]); await f.close()
  }
})

console.log(`\n成员初始化: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
