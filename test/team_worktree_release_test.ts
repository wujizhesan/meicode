import './git-ceiling.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { WorktreeManager } from '../src/worktree/index.ts'
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
    if (Date.now() >= end) throw new Error('租约释放验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(options: { modelWait?: boolean; removeWait?: boolean } = {}) {
  const modelStarted = deferred(), modelGate = deferred(), removeStarted = deferred(), removeGate = deferred()
  const leases = new Set<string>(), failNames = new Set<string>(), attempts: string[] = [], released: string[] = []
  const creates: string[] = [], attaches: string[] = [], removes: string[] = []
  let models = 0, effects = 0, createHook: ((name: string, path: string) => void) | undefined
  const agents: (string | undefined)[] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages, request) {
    models++
    if (options.modelWait && models === 1) {
      modelStarted.resolve(); await modelGate.promise
      if (request.signal?.aborted) return
    }
    if (messages.at(-1)?.role !== 'tool') yield { type: 'tool_call', id: 'release-write-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'ACTUAL-RELEASE-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), worktreeRoot = join(f.root, 'worktrees')
  fs.mkdirSync(worktreeRoot)
  const worktrees = {
    getRoot: () => worktreeRoot,
    create: async (name: string) => {
      creates.push(name); const path = join(worktreeRoot, name), created = !fs.existsSync(path); leases.add(name)
      fs.mkdirSync(path, { recursive: true }); createHook?.(name, path)
      return { name, path, branch: 'wt-' + name, createdAt: Date.now(), dirty: false, created }
    },
    attach: async (name: string, path: string) => {
      attaches.push(name)
      if (leases.has(name)) throw new Error('worktree 正由其他执行者使用: ' + name)
      leases.add(name); return { name, path }
    },
    remove: async (name: string) => {
      removes.push(name)
      removeStarted.resolve(); if (options.removeWait) await removeGate.promise
      return 'worktree 有未提交修改，拒绝删除'
    },
    release: (name: string) => {
      attempts.push(name)
      if (failNames.has(name)) throw new Error('RELEASE-EIO:' + name)
      if (leases.delete(name)) released.push(name)
    },
  }
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() }, worktrees as never)
  const group = team.createGroup('audit', 'lead'), peer = new TeamGroupStore(root), effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '真实租约交接写入', parameters: { type: 'object' }, async execute(_args, ctx) {
    effects++; agents.push(ctx.agentId); fs.appendFileSync(effectsFile, 'ACTUAL-RELEASE-EFFECT\n')
    return { success: true, output: 'ACTUAL-RELEASE-EFFECT' }
  } })
  return { ...f, team, group, peer, leases, failNames, attempts, released, creates, attaches, removes, worktreeRoot, effectsFile,
    modelStarted, modelGate, removeStarted, removeGate, agents,
    get models() { return models }, get effects() { return effects },
    setCreateHook(hook: typeof createHook) { createHook = hook },
    failPublication() { createHook = () => peer.mutateGroup('audit', (current) => { current.lead = 'replacement-lead' }) },
    repairPublication() { createHook = undefined; peer.mutateGroup('audit', (current) => { current.lead = 'lead' }) },
    spawn(name = 'alice') { return team.spawnMember(peer.loadGroup('audit')!, name, 'worker', { agentId: name + '-agent', roleDefinition: null }) },
    async close() { failNames.clear(); modelGate.resolve(); removeGate.resolve(); await team.close(1000); await f.close() },
  }
}

await check('恢复时租约释放失败保留旧宿主，不提前 attach 新身份，重试成功后只执行一次', async () => {
  const f = await fixture()
  try {
    const old = await f.spawn(); f.failNames.add('member-alice')
    f.peer.mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
    assert.deepEqual(await bounded(f.team.restore([])), [])
    assert.equal(f.team.getMember('alice'), old); assert(!old.matchesMember(f.peer.loadGroup('audit')!.members[0]))
    assert.deepEqual(f.attaches, []); assert(f.leases.has('member-alice'))
    f.failNames.clear(); assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice'])
    const current = f.team.getMember('alice')!, group = f.peer.loadGroup('audit')!
    assert.notEqual(current, old); assert(current.matchesMember(group.members[0])); assert.deepEqual(f.attaches, ['member-alice'])
    const task = f.team.addTask('audit', 'SAFE-LEASE-HANDOFF', 'alice')
    assert.match(await bounded(f.team.runTask(group, task, 'alice')), /ACTUAL-RELEASE-DONE/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.deepEqual(f.agents, ['replacement-agent'])
    assert.equal(f.peer.listTasks('audit')[0].attempt, 1)
  } finally { await f.close() }
})

await check('一个成员释放失败不阻断关闭其他成员，重复关闭可补完剩余租约', async () => {
  const f = await fixture()
  try {
    await f.spawn('alice'); await f.spawn('bob'); f.failNames.add('member-alice')
    const result = await bounded(f.team.close(0).then(() => undefined, (error) => error))
    assert(!f.leases.has('member-bob')); assert(f.leases.has('member-alice')); assert.equal(result, undefined)
    f.failNames.clear(); await bounded(f.team.close(0)); assert.equal(f.leases.size, 0)
    assert.deepEqual([...f.released].sort(), ['member-alice', 'member-bob'])
  } finally { await f.close() }
})

await check('关闭后释放失败自动补偿，不依赖再次调用 close', async () => {
  const f = await fixture()
  try {
    await f.spawn(); f.failNames.add('member-alice')
    await f.team.close(0).catch(() => {}); assert(f.leases.has('member-alice'))
    f.failNames.clear(); await waitUntil(() => !f.leases.has('member-alice'))
    assert.deepEqual(f.released, ['member-alice']); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

await check('恢复释放失败的自动补偿保留宿主交接屏障，后续恢复只 attach 一次', async () => {
  const f = await fixture()
  try {
    const old = await f.spawn(); old.close(); f.failNames.add('member-alice')
    await bounded(f.team.restore([])); assert.equal(f.team.getMember('alice'), old); assert.deepEqual(f.attaches, [])
    f.failNames.clear(); await waitUntil(() => !f.leases.has('member-alice'))
    assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice'])
    assert.notEqual(f.team.getMember('alice'), old); assert.deepEqual(f.attaches, ['member-alice'])
    assert(f.leases.has('member-alice'))
  } finally { await f.close() }
})

for (const mode of ['close', 'automatic', 'retry'] as const) await check('初始化回滚释放失败可通过 ' + mode + ' 补偿，保留原始错误和已写产物', async () => {
  const f = await fixture()
  try {
    f.failPublication(); f.failNames.add('member-alice')
    f.setCreateHook((_name, path) => {
      fs.writeFileSync(join(path, 'saved.txt'), 'PRESERVED-FAILED-STARTUP')
      f.peer.mutateGroup('audit', (group) => { group.lead = 'replacement-lead' })
    })
    await assert.rejects(f.spawn(), /花名册已发生变化/)
    assert(f.leases.has('member-alice')); assert.equal(f.team.getMember('alice'), undefined)
    const artifact = join(f.worktreeRoot, 'member-alice', 'saved.txt')
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'PRESERVED-FAILED-STARTUP')
    if (mode === 'retry') {
      f.repairPublication()
      await assert.rejects(f.spawn(), /RELEASE-EIO/); assert.equal(f.creates.length, 1)
    }
    f.failNames.clear()
    if (mode === 'close') await bounded(f.team.close(0))
    else if (mode === 'automatic') await waitUntil(() => !f.leases.has('member-alice'))
    else { const host = await f.spawn(); assert(host.matchesMember(f.peer.loadGroup('audit')!.members[0])); assert.equal(f.creates.length, 2) }
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'PRESERVED-FAILED-STARTUP')
    if (mode !== 'retry') assert.equal(f.leases.size, 0)
    assert.deepEqual(f.released, ['member-alice'])
  } finally { await f.close() }
})

await check('失败初始化补偿后启动新成员，旧重试不释放新宿主的租约', async () => {
  const f = await fixture()
  try {
    f.failPublication(); f.failNames.add('member-alice')
    await assert.rejects(f.spawn(), /花名册已发生变化/); f.repairPublication(); f.failNames.clear()
    const host = await f.spawn(), group = f.peer.loadGroup('audit')!
    const task = f.team.addTask('audit', 'NEW-HOST-OWNS-LEASE', 'alice')
    await bounded(f.team.runTask(group, task, 'alice')); assert.equal(f.effects, 1)
    await new Promise((done) => setTimeout(done, 1200))
    assert(f.leases.has('member-alice')); assert.equal(f.team.getMember('alice'), host)
    assert.deepEqual(f.released, ['member-alice']); assert.equal(f.peer.listTasks('audit')[0].status, 'done')
  } finally { await f.close() }
})

await check('关闭发生在初始化回滚等待中，迟到释放失败仍自动补偿', async () => {
  const f = await fixture({ removeWait: true })
  let initialization: ReturnType<typeof f.spawn> | undefined
  try {
    f.failPublication(); f.failNames.add('member-alice'); initialization = f.spawn()
    const outcome = initialization.then(() => false, (error) => /花名册已发生变化/.test(error.message))
    await bounded(f.removeStarted.promise); await bounded(f.team.close(0))
    assert(f.leases.has('member-alice')); f.removeGate.resolve(); assert.equal(await bounded(outcome), true)
    f.failNames.clear(); await waitUntil(() => !f.leases.has('member-alice'))
    assert.equal(f.team.getMember('alice'), undefined); assert.deepEqual(f.released, ['member-alice'])
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { f.removeGate.resolve(); await initialization?.catch(() => {}); await f.close() }
})

await check('忙碌成员关闭等待实际空闲，延迟释放失败后补偿且没有迟到文件写入', async () => {
  const f = await fixture({ modelWait: true })
  let execution: Promise<string> | undefined
  try {
    const host = await f.spawn(), group = f.peer.loadGroup('audit')!
    const task = f.team.addTask('audit', 'CLOSE-BUSY-MEMBER', 'alice'); execution = f.team.runTask(group, task, 'alice')
    await bounded(f.modelStarted.promise); f.failNames.add('member-alice'); await bounded(f.team.close(0))
    assert(host.isBusy()); assert(f.leases.has('member-alice')); assert.deepEqual(f.attempts, [])
    f.modelGate.resolve(); await bounded(execution); await waitUntil(() => !host.isBusy() && f.attempts.length > 0)
    assert(f.leases.has('member-alice')); f.failNames.clear(); await waitUntil(() => !f.leases.has('member-alice'))
    assert.equal(f.effects, 0); assert.equal(fs.existsSync(f.effectsFile), false); assert.deepEqual(f.released, ['member-alice'])
  } finally { f.modelGate.resolve(); await execution?.catch(() => {}); await f.close() }
})

await check('复用 worktree 初始化失败且释放故障，自动补偿只释放租约，不删除旧产物', async () => {
  const f = await fixture()
  try {
    const path = join(f.worktreeRoot, 'member-alice'); fs.mkdirSync(path)
    const artifact = join(path, 'saved.txt'); fs.writeFileSync(artifact, 'PRESERVED-REUSED-WORKTREE')
    f.failPublication(); f.failNames.add('member-alice'); await assert.rejects(f.spawn(), /花名册已发生变化/)
    assert.deepEqual(f.removes, []); assert(f.leases.has('member-alice'))
    f.failNames.clear(); await waitUntil(() => !f.leases.has('member-alice'))
    assert.deepEqual(f.removes, []); assert.deepEqual(f.released, ['member-alice'])
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'PRESERVED-REUSED-WORKTREE')
  } finally { await f.close() }
})

await check('释放持续失败时真实子进程正常关闭并自行退出，补偿计时器不拖住退出', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), root = join(f.root, 'exit-worker'), finished = join(f.root, 'finished')
  fs.mkdirSync(root)
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const worker = `
      import { mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { TeamManager } from ${JSON.stringify(new URL('../src/team/index.ts', import.meta.url).href)}
      import { ToolRegistry } from ${JSON.stringify(new URL('../src/tools/registry.ts', import.meta.url).href)}
      const [root, finished] = process.argv.slice(1)
      const provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
      const worktrees = {
        getRoot: () => join(root, 'worktrees'),
        create: async (name) => {
          const path = join(root, 'worktrees', name); mkdirSync(path, { recursive: true })
          return { name, path, created: true }
        },
        release: () => { throw new Error('EXIT-RELEASE-EIO') },
      }
      const team = new TeamManager(join(root, 'team'), root, {
        provider, registry: new ToolRegistry(), ctx: { cwd: root, agentId: 'lead-agent', sessionId: 'exit-worker', timeoutMs: 1000 },
      }, worktrees)
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { roleDefinition: null })
      await team.close(0); writeFileSync(finished, 'CLOSED-WITH-PENDING-RELEASE')
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, root, finished], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`释放补偿退出验证失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {}); timer = setTimeout(() => child?.kill(), 5000)
    await bounded(exited); assert.equal(fs.readFileSync(finished, 'utf8'), 'CLOSED-WITH-PENDING-RELEASE')
    assert.match(stderr, /EXIT-RELEASE-EIO/)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

await check('真实 Git 回滚拒删且释放发生故障，自动释放后另一管理器可 attach，未提交产物完整保留', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), repo = join(f.root, 'git-repo'), root = join(f.root, 'real-team')
  fs.mkdirSync(repo)
  const git = (args: string[], cwd = repo) => {
    const result = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
  }
  let team: TeamManager | undefined, worktrees: WorktreeManager | undefined, probe: WorktreeManager | undefined
  let releaseFails = true, createPath = '', releaseAttempts = 0
  const name = 'member-alice'
  try {
    git(['init', '-b', 'main']); fs.writeFileSync(join(repo, 'README.md'), 'ISOLATED-RELEASE-REPO\n')
    git(['add', 'README.md']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'])
    worktrees = new WorktreeManager(repo); probe = new WorktreeManager(repo)
    const release = worktrees.release.bind(worktrees), create = worktrees.create.bind(worktrees)
    worktrees.release = (requested) => { releaseAttempts++; if (releaseFails) throw new Error('REAL-LEASE-RELEASE-EIO'); release(requested) }
    team = new TeamManager(root, repo, { provider, registry: f.registry, ctx: f.chat.getToolContext() }, worktrees)
    const group = team.createGroup('audit', 'lead'), peer = new TeamGroupStore(root)
    worktrees.create = async (requested) => {
      const created = await create(requested); createPath = created.path
      fs.writeFileSync(join(createPath, 'README.md'), 'PRESERVED-USER-CHANGES\n')
      peer.mutateGroup('audit', (current) => { current.lead = 'replacement-lead' })
      return created
    }
    await assert.rejects(team.spawnMember(group, 'alice', 'worker', { roleDefinition: null }), /花名册已发生变化/)
    await assert.rejects(probe.attach(name, createPath), /其他执行者/)
    assert.equal(fs.readFileSync(join(createPath, 'README.md'), 'utf8'), 'PRESERVED-USER-CHANGES\n')
    releaseFails = false; const previousAttempts = releaseAttempts
    await waitUntil(() => releaseAttempts > previousAttempts)
    assert.equal((await probe.attach(name, createPath)).path, createPath)
    assert.equal(fs.readFileSync(join(createPath, 'README.md'), 'utf8'), 'PRESERVED-USER-CHANGES\n')
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], createPath), 'wt-member-alice')
    assert.match(git(['status', '--porcelain'], createPath), /README\.md/)
    assert.equal(team.getMember('alice'), undefined); assert.equal(peer.loadGroup('audit')!.lead, 'replacement-lead')
  } finally { releaseFails = false; probe?.release(name); worktrees?.release(name); await team?.close(1000); await f.close() }
})

console.log(`\n团队 worktree 释放: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
