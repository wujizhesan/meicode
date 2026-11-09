import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import type { MemberHost } from '../src/team/member.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('任务领取一致性验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(failFirst = false) {
  let models = 0, effects = 0
  const prompts: string[] = [], executedBy: string[] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    models++
    if (failFirst && models === 1) throw new Error('REAL-FIRST-ATTEMPT-FAILURE')
    const prompt = messages.filter((message) => message.role === 'user').at(-1)!.content as string
    if (models === (failFirst ? 2 : 1)) {
      prompts.push(prompt)
      yield { type: 'tool_call', id: 'actual-write-' + models, name: 'write_file', arguments: {} }
    } else { yield { type: 'text', text: 'ACTUAL-WORK-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root), peer = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const group = team.createGroup('audit', 'lead'), members = new Map<string, MemberHost>(), memberGroups = new Map<string, string>()
  const scheduler = new TeamTaskScheduler({ store, mail: new TeamMail(join(root, '_shared', 'mail')), members, memberGroups,
    ctx: f.chat.getToolContext(), leaseMs: 60000, leaseHeartbeatMs: 30000 })
  const effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(effectsFile, 'ACTUAL-EFFECT\n'); return { success: true, output: 'ACTUAL-EFFECT' }
  } })
  async function addMember(name: string) {
    const host = await team.spawnMember(group, name, 'worker', { workdir: f.root, roleDefinition: null })
    const execute = host.execute.bind(host)
    host.execute = (title, id, signal) => { executedBy.push(name); return execute(title, id, signal) }
    members.set(name, host); memberGroups.set(name, group.name)
    return host
  }
  await addMember('alice')
  return { ...f, teamRoot: root, store, peer, team, group, scheduler, effectsFile, addMember, prompts, executedBy,
    get models() { return models }, get effects() { return effects },
    async close() { await scheduler.close(1000); await team.close(1000); await f.close() },
  }
}

for (const mode of ['新增依赖', '依赖回退', '延后重试', '次数耗尽', '缩减上限', '转交成员'] as const) await check('领取前另一实例' + mode + '，不执行模型或文件写入', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    if (mode === '转交成员') await f.addMember('bob')
    const dependency = f.scheduler.addTask(f.group.name, 'DEPENDENCY')
    f.store.updateTask(f.group.name, dependency.id, { status: mode === '新增依赖' ? 'todo' : 'done' })
    const task = f.scheduler.addTask(f.group.name, 'CLAIM-OLD-CHECK', 'alice', mode === '依赖回退' ? [dependency.id] : [], 3)
    if (mode === '缩减上限') f.store.updateTask(f.group.name, task.id, { attempt: 1 })
    let injected = false
    f.store.claimTask = (name, id, patch, guard) => {
      if (id === task.id && !injected) {
        injected = true
        if (mode === '新增依赖') f.peer.updateTask(name, id, { depends_on: [dependency.id] })
        if (mode === '依赖回退') f.peer.updateTask(name, dependency.id, { status: 'todo' })
        if (mode === '延后重试') f.peer.updateTask(name, id, { nextRetryAt: Date.now() + 60000 })
        if (mode === '次数耗尽') f.peer.updateTask(name, id, { attempt: 3 })
        if (mode === '缩减上限') f.peer.updateTask(name, id, { maxAttempts: 1 })
        if (mode === '转交成员') f.peer.updateTask(name, id, { assignee: 'bob' })
      }
      return claim(name, id, patch, guard)
    }
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [])
    assert(injected)
    const current = f.store.listTasks(f.group.name).find((item) => item.id === task.id)!
    assert.equal(current.status, 'todo'); assert.equal(current.leaseId, undefined)
    assert.equal(current.attempt ?? 0, mode === '次数耗尽' ? 3 : mode === '缩减上限' ? 1 : 0)
    assert.equal(current.assignee, mode === '转交成员' ? 'bob' : 'alice')
    if (mode === '延后重试') assert(current.nextRetryAt! > Date.now())
    assert.equal(f.models, 0); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 0)
    if (mode === '新增依赖' || mode === '依赖回退') {
      f.peer.updateTask(f.group.name, dependency.id, { status: 'done' })
      assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [task.id])
      await waitUntil(() => f.store.listTasks(f.group.name).find((item) => item.id === task.id)?.status === 'done')
      assert.equal(f.models, 2); assert.equal(f.effects, 1)
    }
    if (mode === '转交成员') {
      assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [task.id])
      await waitUntil(() => f.store.listTasks(f.group.name).find((item) => item.id === task.id)?.status === 'done')
      assert.deepEqual(f.executedBy, ['bob']); assert.equal(f.effects, 1)
    }
  } finally { f.store.claimTask = claim; await f.close() }
})

await check('领取前次数增加但未耗尽，按锁内最新次数执行和落盘', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    const task = f.scheduler.addTask(f.group.name, 'LATEST-ATTEMPT', 'alice', [], 3)
    f.store.updateTask(f.group.name, task.id, { attempt: 1 })
    let injected = false
    f.store.claimTask = (name, id, patch, guard) => {
      if (!injected) { injected = true; f.peer.updateTask(name, id, { attempt: 2 }) }
      return claim(name, id, patch, guard)
    }
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /ACTUAL-WORK-DONE/)
    assert(injected)
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 3)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done')
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
  } finally { f.store.claimTask = claim; await f.close() }
})

for (const timing of ['读取前', '领取前'] as const) await check(timing + '任务标题修改，实际模型只收到最新标题', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    const task = f.scheduler.addTask(f.group.name, 'OLD-TASK-PROMPT', 'alice')
    let injected = timing === '读取前'
    if (injected) f.peer.updateTask(f.group.name, task.id, { title: 'LATEST-TASK-PROMPT' })
    else f.store.claimTask = (name, id, patch, guard) => {
      if (!injected) { injected = true; f.peer.updateTask(name, id, { title: 'LATEST-TASK-PROMPT' }) }
      return claim(name, id, patch, guard)
    }
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /ACTUAL-WORK-DONE/)
    assert(injected); assert.equal(f.prompts.length, 1)
    assert(f.prompts[0].includes('LATEST-TASK-PROMPT')); assert(!f.prompts[0].includes('OLD-TASK-PROMPT'))
    assert.equal(f.store.listTasks(f.group.name)[0].title, 'LATEST-TASK-PROMPT')
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
  } finally { f.store.claimTask = claim; await f.close() }
})

await check('手动执行读到旧分派快照，不能抢回另一实例已转交的任务', async () => {
  const f = await fixture()
  try {
    await f.addMember('bob')
    const task = f.scheduler.addTask(f.group.name, 'LATEST-ASSIGNEE', 'alice')
    f.peer.updateTask(f.group.name, task.id, { assignee: 'bob' })
    await bounded(f.scheduler.runTask(f.group, task, 'alice'))
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].assignee, 'bob')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [task.id])
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'done')
    assert.deepEqual(f.executedBy, ['bob']); assert.equal(f.effects, 1)
  } finally { await f.close() }
})

await check('自动派发遍历旧分派快照时，不能覆盖刚更新的成员', async () => {
  const f = await fixture(), list = f.store.listTasks.bind(f.store)
  try {
    await f.addMember('bob')
    const task = f.scheduler.addTask(f.group.name, 'AUTO-LATEST-ASSIGNEE', 'alice')
    let reads = 0, injected = false
    f.store.listTasks = (name) => {
      if (++reads === 2) { injected = true; f.peer.updateTask(name, task.id, { assignee: 'bob' }) }
      return list(name)
    }
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [])
    assert(injected); f.store.listTasks = list
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].assignee, 'bob')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [task.id])
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'done')
    assert.deepEqual(f.executedBy, ['bob']); assert.equal(f.effects, 1)
  } finally { f.store.listTasks = list; await f.close() }
})

await check('显式指派新成员时，当前分派版本一致则正常执行', async () => {
  const f = await fixture()
  try {
    await f.addMember('bob')
    const task = f.scheduler.addTask(f.group.name, 'EXPLICIT-HANDOFF', 'alice')
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'bob')), /ACTUAL-WORK-DONE/)
    assert.deepEqual(f.executedBy, ['bob']); assert.equal(f.store.listTasks(f.group.name)[0].assignee, 'bob')
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'done'); assert.equal(f.effects, 1)
  } finally { await f.close() }
})

await check('首次未指定成员的旧任务对象，仍可由当前成员继续执行新租约', async () => {
  const f = await fixture()
  try {
    const task = f.scheduler.addTask(f.group.name, 'UNASSIGNED-RETRY', undefined, [], 2)
    f.peer.updateTask(f.group.name, task.id, { assignee: 'alice', attempt: 1 })
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /ACTUAL-WORK-DONE/)
    const current = f.store.listTasks(f.group.name)[0]
    assert.equal(current.status, 'done'); assert.equal(current.assignee, 'alice'); assert.equal(current.attempt, 2)
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
  } finally { await f.close() }
})

await check('不相关任务变动且当前依赖已完成，不阻止正常领取', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  try {
    const dependency = f.scheduler.addTask(f.group.name, 'DONE-DEPENDENCY')
    f.store.updateTask(f.group.name, dependency.id, { status: 'done' })
    const other = f.scheduler.addTask(f.group.name, 'UNRELATED')
    const task = f.scheduler.addTask(f.group.name, 'ELIGIBLE-CLAIM', 'alice', [dependency.id])
    let injected = false
    f.store.claimTask = (name, id, patch, guard) => {
      if (!injected) { injected = true; f.peer.updateTask(name, other.id, { status: 'failed' }) }
      return claim(name, id, patch, guard)
    }
    assert.match(await bounded(f.scheduler.runTask(f.group, task, 'alice')), /ACTUAL-WORK-DONE/)
    assert(injected); assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.equal(f.store.listTasks(f.group.name).find((item) => item.id === task.id)?.status, 'done')
  } finally { f.store.claimTask = claim; await f.close() }
})

await check('已有重试等待时，手动执行入口也不提前执行', async () => {
  const f = await fixture()
  try {
    const task = f.scheduler.addTask(f.group.name, 'WAIT-FOR-RETRY', 'alice', [], 2)
    f.peer.updateTask(f.group.name, task.id, { attempt: 1, nextRetryAt: Date.now() + 60000 })
    await bounded(f.scheduler.runTask(f.group, task, 'alice'))
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    assert.equal(f.store.listTasks(f.group.name)[0].attempt, 1)
    assert(f.store.listTasks(f.group.name)[0].nextRetryAt! > Date.now())
  } finally { await f.close() }
})

await check('失败后转交新加入的成员，原重试定时器按当前分派执行一次', async () => {
  const f = await fixture(true)
  try {
    const task = f.scheduler.addTask(f.group.name, 'RETRY-HANDOFF', 'alice', [], 2)
    await bounded(f.scheduler.runTask(f.group, task, 'alice'))
    assert.equal(f.models, 1); assert.equal(f.effects, 0)
    assert.equal(f.store.listTasks(f.group.name)[0].status, 'todo')
    await f.addMember('bob')
    f.peer.updateTask(f.group.name, task.id, { assignee: 'bob' })
    await waitUntil(() => f.store.listTasks(f.group.name)[0].status === 'done')
    assert.deepEqual(f.executedBy, ['alice', 'bob'])
    const saved = f.store.listTasks(f.group.name)[0]
    assert.equal(saved.assignee, 'bob'); assert.equal(saved.attempt, 2); assert.equal(saved.nextRetryAt, undefined)
    assert.equal(f.models, 3); assert.equal(f.effects, 1)
    assert.equal(fs.readFileSync(f.effectsFile, 'utf8'), 'ACTUAL-EFFECT\n')
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_retry').length, 1)
    assert.equal(f.team.readLeadMail().filter((message) => message.kind === 'task_result').length, 1)
  } finally { await f.close() }
})

await check('真实进程持锁更新依赖，等待锁的领取不得执行旧依赖检查', async () => {
  const f = await fixture(), claim = f.store.claimTask.bind(f.store)
  const ready = join(f.root, 'ready'), gate = join(f.root, 'gate')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const dependency = f.scheduler.addTask(f.group.name, 'PROCESS-DEPENDENCY')
    f.store.updateTask(f.group.name, dependency.id, { status: 'done' })
    const task = f.scheduler.addTask(f.group.name, 'PROCESS-CLAIM', 'alice', [dependency.id])
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, dependency, ready, gate] = process.argv.slice(1)
      new TeamGroupStore(root).mutateTasks('audit', (tasks) => {
        tasks.find((task) => task.id === dependency).status = 'todo'
        writeFileSync(ready, 'ready')
        const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
        while (!existsSync(gate)) {
          if (Date.now() >= end) throw new Error('依赖更新交错超时')
          Atomics.wait(wait, 0, 0, 2)
        }
      })
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, dependency.id, ready, gate], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`依赖更新子进程失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {})
    timer = setTimeout(() => child?.kill(), 8000)
    await waitUntil(() => fs.existsSync(ready))
    let interleaved = false
    f.store.claimTask = (name, id, patch, guard) => {
      if (!interleaved) { interleaved = true; fs.writeFileSync(gate, 'go') }
      return claim(name, id, patch, guard)
    }
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [])
    assert(interleaved); await bounded(exited)
    assert.equal(f.store.listTasks(f.group.name).find((item) => item.id === task.id)?.status, 'todo')
    assert.equal(f.store.listTasks(f.group.name).find((item) => item.id === dependency.id)?.status, 'todo')
    assert.equal(f.models, 0); assert.equal(f.effects, 0); assert(!fs.existsSync(f.effectsFile))
    assert.deepEqual(f.scheduler.scheduleReadyTasks(f.group.name), [])
    assert(!fs.existsSync(join(f.teamRoot, 'audit', 'tasks.lock')))
    assert(!fs.existsSync(join(f.teamRoot, 'audit', 'tasks.lock.queue')))
  } finally {
    f.store.claimTask = claim; clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

console.log(`\n团队领取一致性: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
