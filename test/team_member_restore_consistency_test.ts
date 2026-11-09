import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
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
    if (Date.now() >= end) throw new Error('成员恢复一致性验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(options: { existing?: boolean; delayed?: boolean; modelWait?: boolean; ignoreAbort?: boolean } = {}) {
  const started = deferred(), gate = deferred(), modelStarted = deferred(), modelGate = deferred()
  let models = 0, effects = 0, attaches = 0
  const agents: (string | undefined)[] = [], workdirs: string[] = [], released: string[] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, request) {
    models++
    if (options.modelWait && models === 1) {
      modelStarted.resolve()
      if (options.ignoreAbort) await modelGate.promise
      else await resolveOnAbort(modelGate.promise, request.signal, undefined)
      if (request.signal?.aborted) return
    }
    if (_messages.at(-1)?.role !== 'tool') yield { type: 'tool_call', id: 'restore-write-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'ACTUAL-RESTORED-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), worktreeRoot = join(f.root, 'worktrees')
  const workdir = options.delayed ? join(worktreeRoot, 'member-alice') : f.root
  fs.mkdirSync(workdir, { recursive: true })
  const store = new TeamGroupStore(root), group = store.createGroup('audit', 'lead')
  store.addMember(group, { name: 'alice', agentId: 'original-agent', role: 'worker', workdir, backend: 'coroutine', needsApproval: false, status: 'idle' })
  const worktrees = options.delayed ? {
    getRoot: () => worktreeRoot,
    attach: async (name: string, path: string) => { attaches++; started.resolve(); await gate.promise; return { name, path } },
    release: (name: string) => { released.push(name) },
  } : undefined
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() }, worktrees as never)
  const effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '隔离真实恢复写入', parameters: { type: 'object' }, async execute(_args, ctx) {
    effects++; agents.push(ctx.agentId); workdirs.push(ctx.cwd); fs.appendFileSync(effectsFile, 'REAL-RESTORED-EFFECT\n')
    return { success: true, output: 'REAL-RESTORED-EFFECT' }
  } })
  if (options.existing) await team.restore([])
  return { ...f, teamRoot: root, store, group, team, started, gate, modelStarted, modelGate, effectsFile, workdir,
    agents, workdirs, released, get models() { return models }, get effects() { return effects }, get attaches() { return attaches },
    async close() { gate.resolve(); modelGate.resolve(); await team.close(1000); await f.close() },
  }
}

for (const field of ['agentId', 'role', 'workdir', 'needsApproval', 'closed', 'offline'] as const) await check('同一实例恢复成员 ' + field + ' 变化，替换旧宿主且新成员只执行一次', async () => {
  const f = await fixture({ existing: true }), old = f.team.getMember('alice')!
  try {
    if (field === 'closed') old.close()
    else f.store.mutateGroup('audit', (group) => {
      if (field === 'agentId') group.members[0].agentId = 'replacement-agent'
      if (field === 'role') group.members[0].role = 'replacement-role'
      if (field === 'workdir') { fs.mkdirSync(join(f.root, 'replacement'), { recursive: true }); group.members[0].workdir = join(f.root, 'replacement') }
      if (field === 'needsApproval') group.members[0].needsApproval = true
      if (field === 'offline') group.members[0].status = 'offline'
    })
    assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice'])
    const host = f.team.getMember('alice')!, currentGroup = f.store.loadGroup('audit')!, current = currentGroup.members[0]
    assert.notEqual(host, old); assert(host.matchesMember(current)); assert(!old.matchesMember(current))
    assert.equal(current.agentId, field === 'agentId' ? 'replacement-agent' : 'original-agent')
    assert.equal(f.team.resolveMember({ cwd: current.workdir, agentId: current.agentId })?.member.name, 'alice')
    if (field === 'agentId') assert.equal(f.team.resolveMember({ cwd: f.root, agentId: 'original-agent' }), null)
    const task = f.team.addTask('audit', 'RUN-RESTORED-MEMBER', 'alice')
    const execution = f.team.runTask(currentGroup, task, 'alice')
    if (field === 'needsApproval') {
      await waitUntil(() => f.team.readLeadMail().some((message) => message.kind === 'approval_plan'))
      assert.match(f.team.respondApproval('audit', 'alice', true, undefined, task.id), /已批准/)
    }
    assert.match(await bounded(execution), /ACTUAL-RESTORED-DONE/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.deepEqual(f.agents, [current.agentId]); assert.deepEqual(f.workdirs, [current.workdir])
    assert.equal(f.store.listTasks('audit')[0].status, 'done'); assert.equal(f.store.listTasks('audit')[0].attempt, 1)
  } finally { await f.close() }
})

await check('成员移除后恢复清理旧宿主及身份索引，不重新加入花名册', async () => {
  const f = await fixture({ existing: true }), old = f.team.getMember('alice')!
  try {
    f.store.mutateGroup('audit', (group) => { group.members = [] })
    assert.deepEqual(await bounded(f.team.restore([])), [])
    assert.equal(f.team.getMember('alice'), undefined); assert(!old.matchesMember(f.group.members[0]))
    assert.equal(f.team.resolveMember({ cwd: f.root, agentId: 'original-agent' }), null)
    assert.deepEqual(f.store.loadGroup('audit')!.members, []); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

for (const field of ['agentId', 'role', 'needsApproval', 'workdir', 'removed', 'lead', 'state'] as const) await check('等待 worktree 恢复时花名册 ' + field + ' 变更，旧快照不覆盖新配置或启动任务', async () => {
  const f = await fixture({ delayed: true })
  let restoration: Promise<string[]> | undefined
  try {
    f.store.mutateGroup('audit', (group) => { group.members[0].status = 'busy' })
    restoration = f.team.restore([]); await bounded(f.started.promise)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => {
      if (field === 'agentId') group.members[0].agentId = 'replacement-agent'
      if (field === 'role') group.members[0].role = 'replacement-role'
      if (field === 'needsApproval') group.members[0].needsApproval = true
      if (field === 'workdir') group.members[0].workdir = f.root
      if (field === 'removed') group.members = []
      if (field === 'lead') group.lead = 'replacement-lead'
      if (field === 'state') { group.members[0].status = 'idle'; group.members[0].updatedAt = 123 }
    })
    const expected = f.store.loadGroup('audit')!
    f.gate.resolve(); assert.deepEqual(await bounded(restoration), [])
    assert.deepEqual(f.store.loadGroup('audit'), expected)
    assert.equal(f.team.getMember('alice'), undefined); assert.deepEqual(f.released, ['member-alice'])
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { f.gate.resolve(); await Promise.allSettled([restoration]); await f.close() }
})

await check('关闭发生在 worktree 恢复等待中，迟到 attach 不留下宿主或租约', async () => {
  const f = await fixture({ delayed: true })
  let restoration: Promise<string[]> | undefined
  try {
    restoration = f.team.restore([]); await bounded(f.started.promise)
    const before = f.store.loadGroup('audit')!
    await bounded(f.team.close(0)); f.gate.resolve()
    assert.deepEqual(await bounded(restoration), [])
    assert.equal(f.team.getMember('alice'), undefined); assert.deepEqual(f.released, ['member-alice'])
    assert.deepEqual(f.store.loadGroup('audit'), before); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { f.gate.resolve(); await Promise.allSettled([restoration]); await f.close() }
})

for (const field of ['agentId', 'role', 'needsApproval', 'offline'] as const) await check('旧快照标记成员空闲时 ' + field + ' 已变更，不覆盖新身份状态或时间戳', async () => {
  const f = await fixture({ existing: true })
  try {
    const stale = f.store.loadGroup('audit')!
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => {
      const member = group.members[0]
      if (field === 'agentId') member.agentId = 'replacement-agent'
      if (field === 'role') member.role = 'replacement-role'
      if (field === 'needsApproval') member.needsApproval = true
      member.status = field === 'offline' ? 'offline' : 'busy'; member.updatedAt = 123
    })
    const expected = f.store.loadGroup('audit')!, groupFile = join(f.teamRoot, 'audit', 'group.yaml'), before = fs.statSync(groupFile)
    f.team.markMemberIdle(stale, 'alice')
    assert.deepEqual(f.store.loadGroup('audit'), expected)
    const after = fs.statSync(groupFile)
    assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino)
  } finally { await f.close() }
})

await check('并发恢复共享同一次 attach，成功后可再次恢复且健康宿主不重建或改写花名册', async () => {
  const f = await fixture({ delayed: true })
  let first: Promise<string[]> | undefined, second: Promise<string[]> | undefined
  try {
    const groupFile = join(f.teamRoot, 'audit', 'group.yaml'), before = fs.statSync(groupFile)
    first = f.team.restore([]); await bounded(f.started.promise); second = f.team.restore([])
    assert.equal(first, second); assert.equal(f.attaches, 1)
    f.gate.resolve(); assert.deepEqual(await bounded(first), ['audit/alice']); assert.deepEqual(await bounded(second), ['audit/alice'])
    const host = f.team.getMember('alice'), after = fs.statSync(groupFile)
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs)
    assert.deepEqual(await bounded(f.team.restore([])), [])
    assert.equal(f.team.getMember('alice'), host); assert.equal(f.attaches, 1); assert.deepEqual(f.released, [])
  } finally { f.gate.resolve(); await Promise.allSettled([first, second]); await f.close() }
})

await check('旧成员模型等待中恢复换 Agent，先终止旧执行再由新身份完成新任务', async () => {
  const f = await fixture({ existing: true, modelWait: true }), old = f.team.getMember('alice')!
  let execution: Promise<string> | undefined
  try {
    const task = f.team.addTask('audit', 'OLD-MODEL-WAIT', 'alice')
    execution = f.team.runTask(f.group, task, 'alice'); await bounded(f.modelStarted.promise)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
    assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice'])
    await bounded(execution)
    assert(!old.isBusy()); assert.notEqual(f.team.getMember('alice'), old)
    assert.equal(f.effects, 0); assert.equal(f.models, 1)
    assert.equal(f.store.listTasks('audit').find((item) => item.id === task.id)!.status, 'failed')
    const next = f.team.addTask('audit', 'NEW-IDENTITY-WORK', 'alice')
    assert.match(await bounded(f.team.runTask(f.store.loadGroup('audit')!, next, 'alice')), /ACTUAL-RESTORED-DONE/)
    assert.equal(f.models, 3); assert.equal(f.effects, 1); assert.deepEqual(f.agents, ['replacement-agent'])
    assert.equal(f.store.listTasks('audit').find((item) => item.id === next.id)!.attempt, 1)
    assert.equal(f.store.listTasks('audit').find((item) => item.id === next.id)!.status, 'done')
  } finally { f.modelGate.resolve(); await Promise.allSettled([execution]); await f.close() }
})

await check('旧成员已完成工作等待收尾时换 Agent，恢复仍保存真实结果和历史且不重跑', async () => {
  const f = await fixture({ existing: true }), started = deferred(), gate = deferred(), hooks = f.chat.getToolContext().hooks!
  let execution: Promise<string> | undefined
  try {
    hooks.fire = async (event) => { if (event === 'subagent_stop') { started.resolve(); await gate.promise } }
    const task = f.team.addTask('audit', 'COMPLETED-BEFORE-REPLACEMENT', 'alice')
    execution = f.team.runTask(f.group, task, 'alice'); await bounded(started.promise)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
    assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice'])
    assert.match(await bounded(execution), /ACTUAL-RESTORED-DONE/)
    const saved = f.store.listTasks('audit')[0]
    assert.equal(saved.status, 'done'); assert.equal(saved.attempt, 1); assert.equal(saved.result, 'ACTUAL-RESTORED-DONE')
    assert.equal(f.team.getMember('alice')!.history.view().at(-1)?.content, 'ACTUAL-RESTORED-DONE')
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.deepEqual(f.agents, ['original-agent'])
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
  } finally { gate.resolve(); await Promise.allSettled([execution]); await f.close() }
})

await check('旧成员真实结果已完成但历史保存失败，保留旧实例直到补存成功后交接', async () => {
  const f = await fixture({ existing: true }), old = f.team.getMember('alice')!, saveFailed = deferred(), original = fs.appendFileSync
  const historyFile = join(f.teamRoot, 'audit', 'members', 'alice.history.jsonl')
  let execution: Promise<string> | undefined, blocked = true
  try {
    fs.appendFileSync = ((file: unknown, ...args: unknown[]) => {
      if (blocked && String(file) === historyFile) { saveFailed.resolve(); throw Object.assign(new Error('RESTORE-PENDING-HISTORY-EIO'), { code: 'EIO' }) }
      return (original as (...args: unknown[]) => void)(file, ...args)
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    const task = f.team.addTask('audit', 'PENDING-HISTORY-REPLACEMENT', 'alice')
    execution = f.team.runTask(f.group, task, 'alice'); await bounded(saveFailed.promise)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
    assert.deepEqual(await bounded(f.team.restore([])), [])
    await bounded(execution)
    assert.equal(f.team.getMember('alice'), old); assert.equal(f.store.listTasks('audit')[0].status, 'done')
    assert.equal(f.store.listTasks('audit')[0].attempt, 1); assert.equal(f.models, 2); assert.equal(f.effects, 1)
    blocked = false; fs.appendFileSync = original; syncBuiltinESMExports()
    assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice'])
    assert.notEqual(f.team.getMember('alice'), old)
    assert.equal(f.team.getMember('alice')!.history.view().at(-1)?.content, 'ACTUAL-RESTORED-DONE')
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
  } finally { blocked = false; fs.appendFileSync = original; syncBuiltinESMExports(); await Promise.allSettled([execution]); await f.close() }
})

await check('恢复等待不响应取消的旧模型时关闭，及时结束恢复且迟到模型不启动新成员', async () => {
  const f = await fixture({ existing: true, modelWait: true, ignoreAbort: true }), old = f.team.getMember('alice')!
  let execution: Promise<string> | undefined, restoration: Promise<string[]> | undefined
  try {
    const task = f.team.addTask('audit', 'IGNORES-ABORT-OLD-MODEL', 'alice')
    execution = f.team.runTask(f.group, task, 'alice'); await bounded(f.modelStarted.promise)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
    restoration = f.team.restore([])
    await waitUntil(() => !old.matchesMember(f.group.members[0]))
    assert(old.isBusy()); assert.equal(f.team.getMember('alice'), old)
    await bounded(f.team.close(0)); assert.deepEqual(await bounded(restoration), [])
    f.modelGate.resolve(); await bounded(execution)
    assert(!old.isBusy()); assert.equal(f.models, 1); assert.equal(f.effects, 0)
    assert.equal(f.store.loadGroup('audit')!.members[0].agentId, 'replacement-agent')
    assert.equal(f.team.resolveMember({ cwd: f.root, agentId: 'replacement-agent' }), null)
    assert.notEqual(f.store.listTasks('audit')[0].status, 'done')
  } finally { f.modelGate.resolve(); await Promise.allSettled([execution, restoration]); await f.close() }
})

await check('批量恢复期间已准备的成员正在执行，拒绝旧状态提交时先结束模型再移除宿主', async () => {
  const f = await fixture({ delayed: true, modelWait: true })
  let restoration: Promise<string[]> | undefined, execution: Promise<string> | undefined
  try {
    f.store.mutateGroup('audit', (group) => {
      group.members[0].workdir = f.root
      group.members.push({ ...group.members[0], name: 'bob', agentId: 'bob-agent', workdir: join(f.root, 'worktrees', 'member-bob') })
    })
    restoration = f.team.restore([]); await bounded(f.started.promise)
    const host = f.team.getMember('alice')!, task = f.team.addTask('audit', 'WORK-DURING-RESTORE', 'alice')
    execution = f.team.runTask(f.store.loadGroup('audit')!, task, 'alice'); await bounded(f.modelStarted.promise)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => { group.members[0].status = 'busy'; group.members[0].updatedAt = 123 })
    f.gate.resolve(); assert.deepEqual(await bounded(restoration), ['audit/bob']); await bounded(execution)
    assert(!host.isBusy()); assert.equal(f.team.getMember('alice'), undefined)
    assert.equal(f.models, 1); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert.equal(f.store.loadGroup('audit')!.members[0].updatedAt, 123)
    assert.equal(f.store.listTasks('audit')[0].status, 'failed')
  } finally { f.gate.resolve(); f.modelGate.resolve(); await Promise.allSettled([restoration, execution]); await f.close() }
})

for (const failure of ['stat', 'read', 'corrupt'] as const) await check('恢复花名册 ' + failure + ' 失败保留原宿主，不把未知状态当作成员删除', async () => {
  const f = await fixture({ existing: true }), old = f.team.getMember('alice')!, original = fs.statSync, originalRead = fs.readFileSync
  const groupFile = join(f.teamRoot, 'audit', 'group.yaml'), contents = fs.readFileSync(groupFile, 'utf8')
  try {
    if (failure === 'stat') {
      fs.statSync = ((path, options) => {
        if (String(path) === groupFile) throw Object.assign(new Error('RESTORE-STAT-EACCES'), { code: 'EACCES' })
        return original(path, options)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
    } else if (failure === 'read') {
      fs.appendFileSync(groupFile, '\n# FORCE-RESTORE-RELOAD\n')
      fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
        if (String(path) === groupFile) throw Object.assign(new Error('RESTORE-READ-EIO'), { code: 'EIO' })
        return (originalRead as (...args: unknown[]) => unknown)(path, ...args)
      }) as typeof fs.readFileSync
      syncBuiltinESMExports()
    } else fs.writeFileSync(groupFile, 'name: [BROKEN')
    if (failure === 'stat') await assert.rejects(bounded(f.team.restore([])), /RESTORE-STAT-EACCES/)
    else assert.deepEqual(await bounded(f.team.restore([])), [])
    assert.equal(f.team.getMember('alice'), old); assert(old.matchesMember(f.group.members[0]))
    fs.statSync = original; fs.readFileSync = originalRead; syncBuiltinESMExports(); if (failure !== 'stat') fs.writeFileSync(groupFile, contents)
    assert.deepEqual(await bounded(f.team.restore([])), []); assert.equal(f.team.getMember('alice'), old)
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { fs.statSync = original; fs.readFileSync = originalRead; syncBuiltinESMExports(); if (failure !== 'stat') fs.writeFileSync(groupFile, contents); await f.close() }
})

await check('恢复提交写入失败回滚宿主与 worktree 租约，读取恢复后只启动一次', async () => {
  const f = await fixture({ delayed: true }), original = fs.writeFileSync
  const groupFile = join(f.teamRoot, 'audit', 'group.yaml')
  let restoration: Promise<string[]> | undefined, blocked = false
  try {
    f.store.mutateGroup('audit', (group) => { group.members[0].status = 'busy' })
    const expected = f.store.loadGroup('audit')!
    restoration = f.team.restore([]); await bounded(f.started.promise)
    fs.writeFileSync = ((path: unknown, ...args: unknown[]) => {
      if (blocked && String(path).startsWith(groupFile + '.') && String(path).endsWith('.tmp')) throw Object.assign(new Error('RESTORE-COMMIT-EIO'), { code: 'EIO' })
      return (original as (...args: unknown[]) => void)(path, ...args)
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports(); blocked = true; f.gate.resolve()
    assert.deepEqual(await bounded(restoration), [])
    assert.deepEqual(f.store.loadGroup('audit'), expected); assert.equal(f.team.getMember('alice'), undefined)
    assert.deepEqual(f.released, ['member-alice']); assert.equal(f.models, 0); assert.equal(f.effects, 0)
    blocked = false; fs.writeFileSync = original; syncBuiltinESMExports()
    assert.deepEqual(await bounded(f.team.restore([])), ['audit/alice']); assert.equal(f.attaches, 2)
    const task = f.team.addTask('audit', 'RECOVER-RESTORE-COMMIT', 'alice')
    await bounded(f.team.runTask(f.store.loadGroup('audit')!, task, 'alice'))
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.store.listTasks('audit')[0].status, 'done')
  } finally { blocked = false; fs.writeFileSync = original; syncBuiltinESMExports(); f.gate.resolve(); await Promise.allSettled([restoration]); await f.close() }
})

await check('批量恢复遇到单个成员版本变化时，只提交仍匹配的其他成员', async () => {
  const f = await fixture({ delayed: true })
  let restoration: Promise<string[]> | undefined
  try {
    f.store.mutateGroup('audit', (group) => {
      group.members[0].status = 'busy'
      group.members.push({ ...group.members[0], name: 'bob', agentId: undefined, workdir: f.root })
    })
    restoration = f.team.restore([]); await bounded(f.started.promise)
    new TeamGroupStore(f.teamRoot).mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent'; group.members[0].updatedAt = 123 })
    const expectedAlice = f.store.loadGroup('audit')!.members[0]
    f.gate.resolve(); assert.deepEqual(await bounded(restoration), ['audit/bob'])
    const members = f.store.loadGroup('audit')!.members
    assert.deepEqual(members.find((member) => member.name === 'alice'), expectedAlice)
    assert.equal(f.team.getMember('alice'), undefined); assert(f.team.getMember('bob')!.matchesMember(members.find((member) => member.name === 'bob')!))
    assert.deepEqual(f.released, ['member-alice']); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { f.gate.resolve(); await Promise.allSettled([restoration]); await f.close() }
})

for (const mode of ['idle', 'restore'] as const) await check('真实进程持花名册锁替换成员，旧 ' + mode + ' 更新等待锁后仍核对身份', async () => {
  const f = await fixture({ existing: mode === 'idle' }), original = TeamGroupStore.prototype.updateMemberStatus, originalRestore = TeamGroupStore.prototype.restoreMembers
  if (mode === 'restore') f.store.mutateGroup('audit', (group) => { group.members[0].status = 'busy' })
  const stale = f.store.loadGroup('audit')!
  const ready = join(f.root, 'ready'), gate = join(f.root, 'gate'), finished = join(f.root, 'finished')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, ready, gate, finished] = process.argv.slice(1)
      new TeamGroupStore(root).mutateGroup('audit', (group) => {
        writeFileSync(ready, 'locked')
        const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
        while (!existsSync(gate)) {
          if (Date.now() >= end) throw new Error('空闲更新进程交错启动超时')
          Atomics.wait(wait, 0, 0, 2)
        }
        group.members[0].agentId = 'replacement-agent'; group.members[0].status = 'busy'; group.members[0].updatedAt = 123
      })
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
    void exited.catch(() => {}); timer = setTimeout(() => child?.kill(), 8000)
    await waitUntil(() => fs.existsSync(ready))
    assert(JSON.parse(fs.readFileSync(join(f.teamRoot, 'audit', 'group.lock'), 'utf8')).owner.startsWith(child.pid + '-'))
    TeamGroupStore.prototype.updateMemberStatus = function (...args) { fs.writeFileSync(gate, 'go'); return original.apply(this, args) }
    TeamGroupStore.prototype.restoreMembers = function (...args) { fs.writeFileSync(gate, 'go'); return originalRestore.apply(this, args) }
    if (mode === 'idle') f.team.markMemberIdle(stale, 'alice')
    else { assert.deepEqual(await bounded(f.team.restore([])), []); assert.equal(f.team.getMember('alice'), undefined) }
    await bounded(exited)
    const member = f.store.loadGroup('audit')!.members[0]
    assert.equal(member.agentId, 'replacement-agent'); assert.equal(member.status, 'busy'); assert.equal(member.updatedAt, 123)
    assert(!fs.existsSync(join(f.teamRoot, 'audit', 'group.lock'))); assert(!fs.existsSync(join(f.teamRoot, 'audit', 'group.lock.queue')))
  } finally {
    TeamGroupStore.prototype.updateMemberStatus = original; TeamGroupStore.prototype.restoreMembers = originalRestore
    fs.writeFileSync(gate, 'go'); clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

console.log(`\n成员恢复一致性: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
