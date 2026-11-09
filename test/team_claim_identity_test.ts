import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
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
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= end) throw new Error('任务身份验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
type Conflict = 'agent' | 'name' | 'case' | 'same-group' | 'offline-agent' | 'late-group'
async function fixture(waitModel = false) {
  const started = deferred(), gate = deferred()
  let models = 0, effects = 0, signal: AbortSignal | undefined
  const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
    models++
    if (messages.at(-1)?.role !== 'tool') {
      if (waitModel) { signal = options.signal; started.resolve(); await resolveOnAbort(gate.promise, signal, undefined); if (signal?.aborted) return }
      yield { type: 'tool_call', id: 'identity-effect-' + models, name: 'write_file', arguments: {} }
    } else { yield { type: 'text', text: 'REAL-IDENTITY-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot), peer = new TeamGroupStore(teamRoot)
  const ctx = { ...f.chat.getToolContext(), agentId: 'lead-agent' }
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx })
  const group = team.createGroup('audit', 'lead'), other = peer.createGroup('other', 'other-lead')
  const host = await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
  const scheduler = new TeamTaskScheduler({ store, mail: new TeamMail(join(teamRoot, '_shared', 'mail')),
    members: new Map([['alice', host]]), memberGroups: new Map([['alice', 'audit']]), ctx, leaseMs: 60000, leaseHeartbeatMs: 30000 })
  const effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '真实唯一身份写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(effectsFile, 'ACTUAL-IDENTITY-EFFECT\n'); return { success: true, output: 'ACTUAL-IDENTITY-EFFECT' }
  } })
  const task = scheduler.addTask('audit', 'UNIQUE-IDENTITY-WORK', 'alice')
  const conflictMember = (conflict: Conflict) => ({ ...group.members[0],
    name: conflict === 'name' ? 'alice' : conflict === 'case' ? 'Alice' : 'bob',
    agentId: conflict === 'name' || conflict === 'case' ? 'other-agent' : 'alice-agent',
    status: conflict === 'offline-agent' ? 'offline' as const : 'idle' as const,
  })
  const addConflict = (conflict: Conflict) => {
    if (conflict === 'late-group') {
      fs.mkdirSync(join(teamRoot, 'late')); store.listGroups()
      peer.saveGroup({ name: 'late', lead: 'late-lead', members: [conflictMember(conflict)] })
    } else peer.addMember(conflict === 'same-group' ? group : other, conflictMember(conflict))
  }
  return { ...f, teamRoot, store, peer, team, scheduler, group, other, host, ctx, task, started, gate, effectsFile, conflictMember, addConflict,
    get models() { return models }, get effects() { return effects }, get signal() { return signal },
    async close() { gate.resolve(); await scheduler.close(1000); await team.close(1000); await f.close() },
  }
}

for (const mode of ['manual', 'automatic'] as const) for (const conflict of ['agent', 'name', 'case', 'same-group', 'offline-agent', 'late-group'] as const) await check(mode + ' 领取拒绝持久化 ' + conflict + ' 身份冲突且不消耗执行次数', async () => {
  const f = await fixture()
  try {
    f.addConflict(conflict); const before = f.peer.listTasks('audit')
    if (mode === 'manual') assert.match(await bounded(f.scheduler.runTask(f.group, f.task, 'alice')), /身份|冲突/)
    else assert.deepEqual(f.scheduler.scheduleReadyTasks('audit'), [])
    assert.deepEqual(f.peer.listTasks('audit'), before); assert.equal(f.models, 0); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
  } finally { await f.close() }
})

for (const conflict of ['agent', 'name', 'case'] as const) await check('读到正常任务后领取前新增 ' + conflict + ' 冲突，提交时重新核对', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    let injected = false
    f.store.claimTask = (groupName, id, patch, guard) => {
      if (!injected) { injected = true; f.addConflict(conflict) }
      return claim(groupName, id, patch, guard)
    }
    assert.match(await bounded(f.scheduler.runTask(f.group, f.task, 'alice')), /身份|冲突/)
    assert(injected); assert.equal(f.peer.listTasks('audit')[0].attempt, 0); assert.equal(f.peer.listTasks('audit')[0].status, 'todo')
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { f.store.claimTask = claim; await f.close() }
})

for (const conflict of ['agent', 'name', 'case'] as const) await check('等待模型时其他小组出现 ' + conflict + ' 冲突，停止旧执行且不写文件', async () => {
  const f = await fixture(true)
  let execution: Promise<string> | undefined
  try {
    execution = f.scheduler.runTask(f.group, f.task, 'alice'); await bounded(f.started.promise)
    f.addConflict(conflict); await waitUntil(() => f.signal?.aborted === true)
    await bounded(execution); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert.equal(f.peer.listTasks('audit')[0].status, 'failed'); assert.equal(f.peer.listTasks('audit')[0].attempt, 1)
  } finally { f.gate.resolve(); await execution?.catch(() => {}); await f.close() }
})

for (const failure of ['read', 'corrupt'] as const) await check('其他小组花名册 ' + failure + ' 失败时不领取，修复后正确执行一次', async () => {
  const f = await fixture(), file = join(f.teamRoot, 'other', 'group.yaml'), read = fs.readFileSync, original = fs.readFileSync(file, 'utf8')
  let blocked = false
  try {
    if (failure === 'corrupt') fs.writeFileSync(file, 'broken: [')
    else {
      fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (blocked && String(path) === file) throw Object.assign(new Error('GLOBAL-IDENTITY-EIO'), { code: 'EIO' })
        return Reflect.apply(read, fs, [path, ...args])
      }) as typeof fs.readFileSync
      syncBuiltinESMExports(); blocked = true; fs.utimesSync(file, new Date(), new Date(Date.now() + 1000))
    }
    await assert.rejects(f.scheduler.runTask(f.group, f.task, 'alice'), failure === 'corrupt' ? /损坏/ : /GLOBAL-IDENTITY-EIO/)
    assert.equal(f.peer.listTasks('audit')[0].attempt, 0); assert.equal(f.peer.listTasks('audit')[0].status, 'todo'); assert.equal(f.models, 0)
    blocked = false; fs.writeFileSync(file, original)
    assert.match(await bounded(f.scheduler.runTask(f.group, f.task, 'alice')), /REAL-IDENTITY-DONE/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.peer.listTasks('audit')[0].attempt, 1)
  } finally { blocked = false; fs.readFileSync = read; syncBuiltinESMExports(); await f.close() }
})

for (const recovered of ['valid', 'conflict'] as const) await check('执行期间其他小组花名册读取未知时等待，恢复为 ' + recovered + ' 后按真实身份继续', async () => {
  const f = await fixture(true), stat = fs.statSync, file = join(f.teamRoot, 'other', 'group.yaml')
  let blocked = false, checks = 0, execution: Promise<string> | undefined
  try {
    execution = f.scheduler.runTask(f.group, f.task, 'alice'); await bounded(f.started.promise)
    fs.statSync = ((path, options) => {
      if (blocked && String(path) === file) { checks++; throw Object.assign(new Error('EXECUTING-GLOBAL-IDENTITY-EIO'), { code: 'EIO' }) }
      return stat(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports(); blocked = true; f.gate.resolve()
    await waitUntil(() => checks >= 2)
    assert.equal(f.effects, 0); assert.equal(f.models, 1); assert.equal(f.peer.listTasks('audit')[0].status, 'in_progress'); assert.equal(f.signal?.aborted, false)
    if (recovered === 'conflict') f.addConflict('agent')
    blocked = false; await bounded(execution)
    assert.equal(f.peer.listTasks('audit')[0].attempt, 1)
    assert.equal(f.peer.listTasks('audit')[0].status, recovered === 'valid' ? 'done' : 'failed')
    assert.equal(f.effects, recovered === 'valid' ? 1 : 0); assert.equal(f.models, recovered === 'valid' ? 2 : 1)
  } finally { blocked = false; fs.statSync = stat; syncBuiltinESMExports(); f.gate.resolve(); await execution?.catch(() => {}); await f.close() }
})

await check('其他成员和负责人变动不妨碍唯一身份，正常任务真实写入一次', async () => {
  const f = await fixture()
  try {
    f.peer.addMember(f.other, { ...f.conflictMember('agent'), agentId: 'bob-agent' })
    f.peer.mutateGroup('other', (group) => { group.lead = 'new-lead'; group.members[0].status = 'busy'; group.members[0].updatedAt = Date.now() })
    assert.match(await bounded(f.scheduler.runTask(f.group, f.task, 'alice')), /REAL-IDENTITY-DONE/)
    assert.equal(f.models, 2); assert.equal(f.effects, 1); assert.equal(f.peer.listTasks('audit')[0].status, 'done')
  } finally { await f.close() }
})

for (const conflict of ['agent', 'name', 'case'] as const) await check('真实进程在领取等待锁期间提交 ' + conflict + ' 冲突，旧宿主不领取或执行', async () => {
  const f = await fixture(), ready = join(f.root, 'peer-ready'), result = join(f.root, 'peer-result')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined
  try {
    const worker = `
      import fs from 'node:fs'
      import { join } from 'node:path'
      import { syncBuiltinESMExports } from 'node:module'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      import { withFileLock } from ${JSON.stringify(new URL('../src/runtime/file-lock.ts', import.meta.url).href)}
      const [root, ready, result, member] = process.argv.slice(1), store = new TeamGroupStore(root), rename = fs.renameSync
      const identityLock = join(root, '_shared', 'members.lock'), tasksLock = join(root, 'audit', 'tasks.lock')
      let paused = false, waiting = ''
      fs.renameSync = (source, destination) => {
        if (paused || String(destination) !== join(root, 'other', 'group.yaml')) return rename(source, destination)
        paused = true
        return withFileLock(tasksLock, () => {
          fs.writeFileSync(ready, 'locked')
          const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
          while (!fs.existsSync(identityLock + '.queue') && !fs.existsSync(tasksLock + '.queue')) {
            if (Date.now() >= end) throw new Error('全局身份进程交错超时')
            Atomics.wait(sleep, 0, 0, 2)
          }
          waiting = fs.existsSync(identityLock + '.queue') ? 'identity' : 'tasks'
          return rename(source, destination)
        })
      }
      syncBuiltinESMExports()
      try { store.addMember(store.loadGroup('other'), JSON.parse(member)) }
      finally { fs.renameSync = rename; syncBuiltinESMExports() }
      fs.writeFileSync(result, waiting)
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, ready, result, JSON.stringify(f.conflictMember(conflict))], { cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || '身份进程退出 ' + code))) }); void exited.catch(() => {})
    await waitUntil(() => fs.existsSync(ready))
    const before = f.peer.listTasks('audit')
    assert.match(await bounded(f.scheduler.runTask(f.group, f.task, 'alice')), /身份|冲突/)
    await bounded(exited); assert.equal(fs.readFileSync(result, 'utf8'), 'identity')
    assert.deepEqual(f.peer.listTasks('audit'), before); assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.peer.loadGroup('other')!.members.length, 1); assert(!fs.existsSync(join(f.teamRoot, '_shared', 'members.lock')))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.allSettled(exited ? [exited] : []); await f.close()
  }
})

await check('真实领取提交持有全局身份锁，其他小组的冲突提交等待后再终止旧执行', async () => {
  const f = await fixture(true), ready = join(f.root, 'peer-ready'), gate = join(f.root, 'peer-gate'), result = join(f.root, 'peer-result')
  const rename = fs.renameSync, identityLock = join(f.teamRoot, '_shared', 'members.lock')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, execution: Promise<string> | undefined
  try {
    const worker = `
      import fs from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, ready, gate, result, member] = process.argv.slice(1), store = new TeamGroupStore(root)
      fs.writeFileSync(ready, 'ready')
      const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
      while (!fs.existsSync(gate)) { if (Date.now() >= end) throw new Error('提交全局身份交错超时'); Atomics.wait(sleep, 0, 0, 2) }
      store.addMember(store.loadGroup('other'), JSON.parse(member)); fs.writeFileSync(result, 'finished')
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, ready, gate, result, JSON.stringify(f.conflictMember('agent'))], { cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || '提交身份进程退出 ' + code))) }); void exited.catch(() => {})
    await waitUntil(() => fs.existsSync(ready))
    let paused = false
    fs.renameSync = (source, destination) => {
      if (!paused && String(destination) === join(f.teamRoot, 'audit', 'tasks.json') && JSON.parse(fs.readFileSync(source, 'utf8')).some((task: TeamTask) => task.status === 'in_progress')) {
        paused = true; fs.writeFileSync(gate, 'go')
        const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 2500
        while (!fs.existsSync(identityLock + '.queue') && !fs.existsSync(result)) {
          if (Date.now() >= end) throw new Error('领取提交未保护全局身份')
          Atomics.wait(sleep, 0, 0, 2)
        }
        assert(!fs.existsSync(result)); assert(String(JSON.parse(fs.readFileSync(identityLock, 'utf8')).owner).startsWith(process.pid + '-'))
      }
      return rename(source, destination)
    }
    syncBuiltinESMExports(); execution = f.scheduler.runTask(f.group, f.task, 'alice')
    await bounded(execution); await bounded(exited); assert(paused)
    assert.equal(f.peer.listTasks('audit')[0].status, 'failed'); assert.equal(f.peer.listTasks('audit')[0].attempt, 1)
    assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile)); assert(!fs.existsSync(identityLock)); assert(!fs.existsSync(identityLock + '.queue'))
  } finally {
    fs.renameSync = rename; syncBuiltinESMExports(); f.gate.resolve(); fs.writeFileSync(gate, 'finish')
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.allSettled([...(exited ? [exited] : []), ...(execution ? [execution] : [])]); await f.close()
  }
})

console.log(`\n任务全局身份: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
