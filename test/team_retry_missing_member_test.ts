import assert from 'node:assert/strict'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

// 到期重试那一刻成员不在本实例（进程重启后还没恢复、或已被划到别的小组）时，
// 修复前的实现会把这条重试直接丢弃：任务停在 todo，谁也不再排下一次检查，
// 只有 60s 一次的 reconcileManagedGroups 兜底扫描才可能重新派发。
//
// 这条分支此前只有"读代码读出来"的结论、没有回归测试（要在定时器排好之后让成员
// 从实例里消失，用公开 API 不好稳定构造）。这里直接拿 TeamManager 与调度器共享的
// 那张成员表做文章——调度器构造函数接收的就是同一个 Map 引用。
let calls = 0
const provider: Provider = { protocol: 'openai', async *streamChat() {
  const round = ++calls
  if (round === 1) throw new Error('REAL-RETRY-FAILURE')
  yield { type: 'text', text: 'RETRY-COMPLETED' }
  yield { type: 'done' }
} }

const f = await streamFixture(provider)
const root = f.root + '/team'
const store = new TeamGroupStore(root)
const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
// 调度器持有的是 TeamManager 的同一张表，删掉条目即等价于"成员还没恢复到本实例"
const internals = team as unknown as { members: Map<string, unknown>; memberGroups: Map<string, string> }
try {
  const group = team.createGroup('audit', 'lead')
  await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
  const target = team.addTask(group.name, 'RETRY-TARGET', 'alice', [], 2)
  assert.match(await bounded(team.runTask(group, target, 'alice')), /REAL-RETRY-FAILURE/)
  const first = store.listTasks(group.name).find((item) => item.id === target.id)!
  assert.equal(first.status, 'todo')
  assert.equal(first.attempt, 1)

  const host = internals.members.get('alice')!
  internals.members.delete('alice')
  internals.memberGroups.delete('alice')
  // 越过到期时刻：此时没人能接手，任务不该被执行，但重试也不该被丢掉
  await new Promise((done) => setTimeout(done, Math.max(300, (first.nextRetryAt ?? 0) - Date.now() + 400)))
  assert.equal(store.listTasks(group.name).find((item) => item.id === target.id)!.status, 'todo')
  assert.equal(calls, 1, '成员缺失期间不应执行')

  // 成员恢复：重试必须还在队列里，而不是等 60s 的兜底扫描
  internals.members.set('alice', host)
  internals.memberGroups.set('alice', group.name)
  const deadline = Date.now() + 10000
  let latest = store.listTasks(group.name).find((item) => item.id === target.id)!
  while (latest.status !== 'done' && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25))
    latest = store.listTasks(group.name).find((item) => item.id === target.id)!
  }
  assert.equal(latest.status, 'done', '成员缺失期间到期的重试被永久丢弃')
  assert.equal(latest.attempt, 2)
  assert.equal(calls, 2)
} finally { await team.close(1000); await f.close() }

console.log('team_retry_missing_member_test passed')
