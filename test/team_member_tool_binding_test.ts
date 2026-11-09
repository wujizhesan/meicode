import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= end) throw new Error('成员工具进程交错超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture() {
  let models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    models++; yield { type: 'text', text: 'TOOL-BINDING-DONE' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider), teamRoot = join(f.root, 'team'), ctx = { ...f.chat.getToolContext(), agentId: 'lead-agent' }
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx })
  const peer = new TeamGroupStore(teamRoot), mail = new TeamMail(join(teamRoot, '_shared', 'mail'))
  const group = team.createGroup('first', 'lead')
  const host = await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
  const tools = team.memberTools(), taskTool = tools.find((tool) => tool.name === 'team_task')!, sendTool = tools.find((tool) => tool.name === 'team_send')!
  const context = { cwd: group.members[0].workdir, agentId: 'alice-agent' }
  const task = team.addTask('first', 'ORIGINAL-TASK', 'alice')
  return { ...f, teamRoot, ctx, team, peer, mail, group, host, taskTool, sendTool, context, task, get models() { return models },
    async rejectedContexts(contexts = [context, { cwd: context.cwd }]) {
      const before = peer.listTasks('first')
      for (const context of contexts) {
        for (const args of [{ action: 'list' }, { action: 'get', id: task.id }, { action: 'create', title: 'STALE-CREATE' }, { action: 'update', id: task.id, result: 'STALE-UPDATE' }]) {
          assert.equal((await taskTool.execute(args, context)).success, false)
        }
        assert.equal((await sendTool.execute({ to: 'target', body: 'STALE-MAIL' }, context)).success, false)
      }
      assert.deepEqual(peer.listTasks('first'), before); assert.deepEqual(mail.read('target'), []); assert.equal(models, 0)
    },
    async close() { await team.close(1000); await f.close() },
  }
}

for (const field of ['agentId', 'role', 'approval', 'workdir', 'offline', 'removed'] as const) await check('持久化成员 ' + field + ' 变化后旧 Agent 和目录上下文均不能操作任务或邮箱', async () => {
  const f = await fixture()
  try {
    f.peer.mutateGroup('first', (group) => {
      const member = group.members[0]
      if (field === 'agentId') member.agentId = 'replacement-agent'
      if (field === 'role') member.role = 'reviewer'
      if (field === 'approval') member.needsApproval = true
      if (field === 'workdir') member.workdir = join(f.root, 'replacement')
      if (field === 'offline') member.status = 'offline'
      if (field === 'removed') group.members = []
    })
    await f.rejectedContexts()
  } finally { await f.close() }
})

for (const state of ['host', 'team'] as const) await check(state + ' 关闭后保留的工具不能写入，主会话也不能向已关闭团队发送消息', async () => {
  const f = await fixture()
  try {
    if (state === 'host') f.host.close(); else await f.team.close()
    await f.rejectedContexts()
    if (state === 'team') assert.equal((await f.sendTool.execute({ to: 'target', body: 'CLOSED-LEAD' }, f.ctx)).success, false)
    assert.deepEqual(f.mail.read('target'), [])
  } finally { await f.close() }
})

for (const conflict of ['agent', 'name', 'case', 'late-group'] as const) await check('已驻留成员遇到其他小组 ' + conflict + ' 身份冲突时不能继续使用旧工具', async () => {
  const f = await fixture()
  try {
    if (conflict === 'late-group') { fs.mkdirSync(join(f.teamRoot, 'other')); f.team.listGroups() }
    const other = conflict === 'late-group' ? { name: 'other', lead: 'other-lead', members: [] } : f.peer.createGroup('other', 'other-lead')
    f.peer.saveGroup({ ...other, members: [{ ...f.group.members[0], name: conflict === 'name' ? 'alice' : conflict === 'case' ? 'Alice' : 'bob', agentId: conflict === 'name' || conflict === 'case' ? 'other-agent' : 'alice-agent' }] })
    await f.rejectedContexts()
  } finally { await f.close() }
})

for (const state of ['offline', 'removed', 'workdir', 'closed'] as const) await check('同目录旧成员 ' + state + ' 后目录上下文不能冒充另一个正常成员', async () => {
  const f = await fixture()
  try {
    await f.team.spawnMember(f.group, 'bob', 'worker', { agentId: 'bob-agent', roleDefinition: null })
    if (state === 'closed') f.host.close()
    else f.peer.mutateGroup('first', (group) => {
      if (state === 'removed') group.members = group.members.filter((member) => member.name !== 'alice')
      if (state === 'offline') group.members.find((member) => member.name === 'alice')!.status = 'offline'
      if (state === 'workdir') group.members.find((member) => member.name === 'alice')!.workdir = join(f.root, 'moved')
    })
    await f.rejectedContexts([{ cwd: f.context.cwd }])
    assert.equal((await f.taskTool.execute({ action: 'list' }, { cwd: f.context.cwd, agentId: 'bob-agent' })).success, true)
  } finally { await f.close() }
})

await check('花名册读取失败时工具返回失败结果并保持原任务和邮箱', async () => {
  const f = await fixture(), read = fs.readFileSync
  try {
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === join(f.teamRoot, 'first', 'group.yaml')) throw Object.assign(new Error('TOOL-ROSTER-EIO'), { code: 'EIO' })
      return Reflect.apply(read, fs, [file, ...args])
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    fs.utimesSync(join(f.teamRoot, 'first', 'group.yaml'), new Date(), new Date(Date.now() + 1000))
    await f.rejectedContexts()
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); await f.close() }
})

await check('其他小组花名册损坏时不跳过未知身份，也不污染正常小组任务', async () => {
  const f = await fixture()
  try {
    f.peer.createGroup('other', 'other-lead')
    fs.writeFileSync(join(f.teamRoot, 'other', 'group.yaml'), 'broken: [')
    await f.rejectedContexts()
  } finally { await f.close() }
})

await check('邮箱写入失败时返回工具失败而不是抛出异常', async () => {
  const f = await fixture(), append = fs.appendFileSync
  try {
    fs.appendFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === join(f.teamRoot, '_shared', 'mail', 'target.mail')) throw Object.assign(new Error('TOOL-MAIL-EIO'), { code: 'EIO' })
      return Reflect.apply(append, fs, [file, ...args])
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    const result = await f.sendTool.execute({ to: 'target', body: 'NO-PARTIAL-MAIL' }, f.context)
    assert.equal(result.success, false); assert.match(result.error!, /TOOL-MAIL-EIO/); assert.deepEqual(f.mail.read('target'), [])
    assert.equal(f.peer.listTasks('first').length, 1)
  } finally { fs.appendFileSync = append; syncBuiltinESMExports(); await f.close() }
})

await check('正常身份可创建更新读取任务和发送消息，主会话发送者保持 lead', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.taskTool.execute({ action: 'create', title: 'VALID-CREATE' }, f.context)).success, true)
    assert.equal((await f.taskTool.execute({ action: 'update', id: f.task.id, result: 'VALID-UPDATE' }, f.context)).success, true)
    assert.equal(JSON.parse((await f.taskTool.execute({ action: 'get', id: f.task.id }, f.context)).output).result, 'VALID-UPDATE')
    assert.equal((await f.taskTool.execute({ action: 'list' }, { cwd: f.context.cwd })).success, true)
    assert.equal((await f.sendTool.execute({ to: 'Lead', body: 'VALID-MEMBER' }, f.context)).success, true)
    const leadContext = { cwd: f.ctx.cwd }
    const leadTeam = new TeamManager(join(f.root, 'legacy-team'), f.root, { provider: { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }, registry: f.registry, ctx: leadContext })
    try {
      const group = leadTeam.createGroup('legacy', 'lead')
      await leadTeam.spawnMember(group, 'bob', 'worker', { roleDefinition: null })
      assert.equal((await leadTeam.memberTools().find((tool) => tool.name === 'team_send')!.execute({ to: 'target', body: 'VALID-LEAD' }, leadContext)).success, true)
      assert.equal(new TeamMail(join(f.root, 'legacy-team', '_shared', 'mail')).read('target')[0].from, 'lead')
    } finally { await leadTeam.close() }
    assert.equal(f.mail.read('lead')[0].from, 'alice'); assert.equal(f.peer.listTasks('first').length, 2); assert.equal(f.models, 0)
  } finally { await f.close() }
})

await check('完成依赖任务后仍能派发后续真实任务，身份锁不阻塞调度', async () => {
  const f = await fixture()
  try {
    const next = f.team.addTask('first', 'NEXT-ACTUAL-WORK', 'alice', [f.task.id])
    assert.equal((await bounded(f.taskTool.execute({ action: 'update', id: f.task.id, status: 'done' }, f.context))).success, true)
    await waitUntil(() => f.peer.listTasks('first').find((task) => task.id === next.id)?.status === 'done')
    assert.equal(f.models, 1); assert.equal(f.peer.listTasks('first').find((task) => task.id === next.id)?.attempt, 1)
  } finally { await f.close() }
})

for (const action of ['create', 'update'] as const) await check('真实进程持有身份锁并替换成员时等待中的 ' + action + ' 重新核验身份', async () => {
  const f = await fixture(), ready = join(f.root, 'roster-ready'), result = join(f.root, 'worker-result.json')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined
  try {
    const worker = `
      import fs from 'node:fs'
      import { join } from 'node:path'
      import { syncBuiltinESMExports } from 'node:module'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      import { withFileLock } from ${JSON.stringify(new URL('../src/runtime/file-lock.ts', import.meta.url).href)}
      const [root, ready, result] = process.argv.slice(1), store = new TeamGroupStore(root), rename = fs.renameSync
      const taskLock = join(root, 'first', 'tasks.lock'), memberLock = join(root, '_shared', 'members.lock')
      let paused = false, waiting = ''
      fs.renameSync = (source, destination) => {
        if (String(destination) !== join(root, 'first', 'group.yaml') || paused) return rename(source, destination)
        paused = true
        return withFileLock(taskLock, () => {
          fs.writeFileSync(ready, 'identity-and-tasks-locked')
          const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
          while (!fs.existsSync(memberLock + '.queue') && !fs.existsSync(taskLock + '.queue')) {
            if (Date.now() >= end) throw new Error('工具等待身份进程交错超时')
            Atomics.wait(sleep, 0, 0, 2)
          }
          waiting = fs.existsSync(memberLock + '.queue') ? 'identity' : 'tasks'
          return rename(source, destination)
        })
      }
      syncBuiltinESMExports()
      try { store.mutateGroup('first', (group) => { group.members[0].agentId = 'replacement-agent' }) }
      finally { fs.renameSync = rename; syncBuiltinESMExports() }
      fs.writeFileSync(result, JSON.stringify({ waiting }))
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, ready, result], { cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || '工具身份进程退出 ' + code))) }); void exited.catch(() => {})
    await waitUntil(() => fs.existsSync(ready))
    assert(String(JSON.parse(fs.readFileSync(join(f.teamRoot, '_shared', 'members.lock'), 'utf8')).owner).startsWith(String(child.pid)))
    const before = f.peer.listTasks('first')
    const outcome = await f.taskTool.execute(action === 'create' ? { action, title: 'STALE-PROCESS-CREATE' } : { action, id: f.task.id, result: 'STALE-PROCESS-UPDATE' }, f.context)
    await bounded(exited)
    assert.equal(outcome.success, false); assert.deepEqual(f.peer.listTasks('first'), before)
    assert.equal(f.peer.loadGroup('first')!.members[0].agentId, 'replacement-agent')
    assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).waiting, 'identity'); assert.equal(f.models, 0)
    assert(!fs.existsSync(join(f.teamRoot, '_shared', 'members.lock')))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.allSettled(exited ? [exited] : []); await f.close()
  }
})

for (const action of ['task', 'mail'] as const) await check('真实 ' + action + ' 写入提交前身份锁阻止其他进程替换成员', async () => {
  const f = await fixture(), ready = join(f.root, 'peer-ready'), gate = join(f.root, 'peer-gate'), result = join(f.root, 'peer-result.json')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined
  const rename = fs.renameSync, append = fs.appendFileSync
  try {
    const worker = `
      import fs from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, ready, gate, result] = process.argv.slice(1), store = new TeamGroupStore(root)
      fs.writeFileSync(ready, 'peer-ready')
      const end = Date.now() + 5000
      while (!fs.existsSync(gate)) {
        if (Date.now() >= end) throw new Error('提交身份进程交错超时')
        await new Promise((done) => setTimeout(done, 10))
      }
      store.mutateGroup('first', (group) => { group.members[0].agentId = 'replacement-agent' })
      fs.writeFileSync(result, JSON.stringify({ tasks: store.listTasks('first') }))
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, ready, gate, result], { cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || '提交身份进程退出 ' + code))) }); void exited.catch(() => {})
    await waitUntil(() => fs.existsSync(ready))
    let paused = false
    const pauseCommit = () => {
      paused = true; fs.writeFileSync(gate, 'change-member')
      const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 2500
      const memberLock = join(f.teamRoot, '_shared', 'members.lock')
      while (!fs.existsSync(memberLock + '.queue')) {
        if (Date.now() >= end) throw new Error('写入提交期间未保护身份')
        Atomics.wait(sleep, 0, 0, 2)
      }
      assert(!fs.existsSync(result)); assert.equal(f.peer.loadGroup('first')!.members[0].agentId, 'alice-agent')
      assert(String(JSON.parse(fs.readFileSync(memberLock, 'utf8')).owner).startsWith(String(process.pid)))
    }
    fs.renameSync = (source, destination) => {
      if (action === 'task' && String(destination) === join(f.teamRoot, 'first', 'tasks.json')) pauseCommit()
      return rename(source, destination)
    }
    fs.appendFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (action === 'mail' && String(file) === join(f.teamRoot, '_shared', 'mail', 'target.mail')) pauseCommit()
      return Reflect.apply(append, fs, [file, ...args])
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    const outcome = action === 'task'
      ? await f.taskTool.execute({ action: 'create', title: 'COMMITTED-BEFORE-REPLACEMENT' }, f.context)
      : await f.sendTool.execute({ to: 'target', body: 'COMMITTED-BEFORE-REPLACEMENT' }, f.context)
    fs.renameSync = rename; fs.appendFileSync = append; syncBuiltinESMExports()
    await bounded(exited); assert(paused); assert.equal(outcome.success, true)
    assert.equal(f.peer.loadGroup('first')!.members[0].agentId, 'replacement-agent')
    if (action === 'task') assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).tasks.length, 2)
    else { assert.equal(f.mail.read('target').length, 1); assert.equal(f.mail.read('target')[0].from, 'alice') }
    const before = f.peer.listTasks('first')
    assert.equal((await f.taskTool.execute({ action: 'create', title: 'STALE-AFTER-COMMIT' }, f.context)).success, false)
    assert.equal((await f.sendTool.execute({ to: 'target', body: 'STALE-AFTER-COMMIT' }, f.context)).success, false)
    assert.deepEqual(f.peer.listTasks('first'), before); assert.equal(f.mail.read('target').length, action === 'mail' ? 1 : 0)
  } finally {
    fs.renameSync = rename; fs.appendFileSync = append; syncBuiltinESMExports(); fs.writeFileSync(gate, 'finish')
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.allSettled(exited ? [exited] : []); await f.close()
  }
})

console.log(`\n成员工具身份绑定: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
