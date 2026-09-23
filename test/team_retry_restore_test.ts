import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { WorktreeManager } from '../src/worktree/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: '重试任务完成' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_team_retry_restore')
const repo = join(root, 'repo')
rmSync(root, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
spawnSync('git', ['init', '-b', 'main'], { cwd: repo })
writeFileSync(join(repo, 'README.md'), '# team restore\n', 'utf8')
spawnSync('git', ['add', '-A'], { cwd: repo })
spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { cwd: repo })

const options = { provider: new FakeProvider(), registry: { toOpenAITools: () => [] } as never, ctx: { cwd: repo } }
const firstWorktrees = new WorktreeManager(repo)
const first = new TeamManager(join(root, 'team'), repo, options, firstWorktrees)
const group = first.createGroup('retry', 'lead')
await first.spawnMember(group, 'alice', 'worker')
const store = new TeamGroupStore(join(root, 'team'))
const groupFile = join(root, 'team', 'retry', 'group.yaml')
const persistedAgentId = store.loadGroup('retry')?.members[0].agentId
const groupBeforeRestore = statSync(groupFile)
const repairGroup = first.createGroup('repair', 'lead')
store.addMember(repairGroup, { name: 'bob', role: 'worker', workdir: repo, backend: 'coroutine', needsApproval: false, status: 'offline' })
store.saveTasks('retry', [{ id: 'retry-1', title: '重启后重试', assignee: 'alice', status: 'todo', attempt: 1, maxAttempts: 2, nextRetryAt: Date.now() + 30 }])
await first.close()

const restoredWorktrees = new WorktreeManager(repo)
const restored = new TeamManager(join(root, 'team'), repo, options, restoredWorktrees)
await restored.restore()
const restoredGroup = store.loadGroup('retry')
const groupAfterRestore = statSync(groupFile)
if (restoredGroup?.members[0].agentId !== persistedAgentId) throw new Error('恢复后成员 agentId 未复用')
if (groupBeforeRestore.ino !== groupAfterRestore.ino || groupBeforeRestore.mtimeMs !== groupAfterRestore.mtimeMs || groupBeforeRestore.ctimeMs !== groupAfterRestore.ctimeMs) {
  throw new Error('成员状态未变化时仍然改写 group.yaml')
}
const repairedMember = store.loadGroup('repair')?.members[0]
if (!repairedMember?.agentId || repairedMember.status !== 'idle') throw new Error('旧成员缺失 ID 或异常状态未修复')
let task = restored.listTasks('retry').find((item) => item.id === 'retry-1')
const retryDeadline = Date.now() + 2000
while (task?.status !== 'done' && Date.now() < retryDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25))
  task = restored.listTasks('retry').find((item) => item.id === 'retry-1')
}
if (task?.status !== 'done') throw new Error(`重启后待重试任务未执行: ${task?.status}`)

const contender = new WorktreeManager(repo)
let leaseRejected = false
try {
  await contender.create('member-alice')
} catch (error) {
  leaseRejected = (error as Error).message.includes('其他执行者使用')
}
if (!leaseRejected) throw new Error('恢复后的团队成员未重新持有 worktree 租约')

await restored.close()
await contender.create('member-alice')
const removed = await contender.remove('member-alice')
if (!removed.includes('已删除')) throw new Error(`团队关闭后未释放 worktree 租约: ${removed}`)
rmSync(root, { recursive: true, force: true })
console.log('team_retry_restore_test passed')
