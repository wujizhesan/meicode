import assert from 'node:assert/strict'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

// 到期重试必须真的交到成员手上：如果重试定时器到期那一刻成员正忙，
// 旧实现会把这条重试直接丢弃（没有任何再排 jmp），任务只能等到
// reconcileManagedGroups 的兜底扫描（默认 200s）才可能被捞起来。
let calls = 0
const started = deferred(), gate = deferred()
const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
  const round = ++calls
  if (round === 1) throw new Error('REAL-RETRY-FAILURE')
  if (round === 2) {
    started.resolve()
    yield { type: 'text', text: 'HOLDING' }
    await new Promise<void>((done) => { const timer = setTimeout(done, 10); options.signal?.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true }) })
    await gate.promise
    throw new Error('REAL-HOLD-FAILURE')
  }
  yield { type: 'text', text: 'RETRY-COMPLETED' }
  yield { type: 'done' }
} }

const f = await streamFixture(provider)
const root = f.root + '/team'
const store = new TeamGroupStore(root)
const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
try {
  const group = team.createGroup('audit', 'lead')
  await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
  const target = team.addTask(group.name, 'RETRY-TARGET', 'alice', [], 2)
  const holder = team.addTask(group.name, 'HOLD-MEMBER', 'alice', [], 1)
  assert.match(await bounded(team.runTask(group, target, 'alice')), /REAL-RETRY-FAILURE/)
  const first = store.listTasks(group.name).find((task) => task.id === target.id)!
  assert.equal(first.status, 'todo')
  assert.equal(first.attempt, 1)
  const dueAt = first.nextRetryAt!
  const holding = bounded(team.runTask(group, holder, 'alice'))
  await bounded(started.promise)
  // 让重试到期时刻落在成员被占用的窗口里
  await new Promise<void>((done) => setTimeout(done, Math.max(200, dueAt - Date.now() + 300)))
  assert(store.listTasks(group.name).find((task) => task.id === target.id)!.status === 'todo')
  gate.resolve()
  assert.match(await holding, /REAL-HOLD-FAILURE/)
  const deadline = Date.now() + 10000
  let latest = store.listTasks(group.name).find((task) => task.id === target.id)!
  while (latest.status !== 'done' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25))
    latest = store.listTasks(group.name).find((task) => task.id === target.id)!
  }
  assert.equal(latest.status, 'done', '重试到期时成员正忙，任务被永久搁置')
  assert.equal(latest.attempt, 2)
  assert.equal(calls, 3)
  const final = store.listTasks(group.name).find((task) => task.id === holder.id)!
  assert.equal(final.status, 'failed')
  assert.equal(final.attempt, 1)
} finally { gate.resolve(); await team.close(1000); await f.close() }

console.log('team_retry_handoff_test passed')
