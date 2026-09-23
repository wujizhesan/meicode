import { mergeTeamWorktrees } from '../src/team/merge.ts'
import {
  readyTasks,
  recoverExpiredTasks,
  taskBlockers,
  validateTaskDependencies,
} from '../src/team/task-graph.ts'
import type { TeamGroup, TeamTask } from '../src/team/types.ts'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WorktreeManager } from '../src/worktree/index.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}: ${(error as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

await check('validateTaskDependencies: 拒绝缺失依赖与循环依赖', () => {
  const tasks: TeamTask[] = [
    { id: 'a', title: 'A', status: 'todo', depends_on: ['b'] },
    { id: 'b', title: 'B', status: 'todo' },
  ]
  assert(validateTaskDependencies(tasks, 'c', ['missing'])?.includes('不存在'), '缺失依赖未被拒绝')
  assert(validateTaskDependencies(tasks, 'b', ['a'])?.includes('循环'), '循环依赖未被拒绝')
  assert(validateTaskDependencies(tasks, 'c', ['b']) === null, '合法依赖被拒绝')
})

await check('taskBlockers: 仅完成的依赖解除阻塞', () => {
  const tasks: TeamTask[] = [
    { id: 'done', title: '完成', status: 'done' },
    { id: 'todo', title: '待办', status: 'todo' },
  ]
  const task: TeamTask = { id: 'next', title: '后续', status: 'todo', depends_on: ['done', 'todo', 'missing'] }
  const blockers = taskBlockers(tasks, task)
  assert(blockers.join(',') === 'todo,missing', `阻塞列表异常: ${blockers.join(',')}`)
})

await check('readyTasks: 同时检查状态、重试时间和依赖', () => {
  const tasks: TeamTask[] = [
    { id: 'done', title: '完成', status: 'done' },
    { id: 'ready', title: '就绪', status: 'todo', depends_on: ['done'] },
    { id: 'later', title: '稍后', status: 'todo', nextRetryAt: 101 },
    { id: 'running', title: '执行中', status: 'in_progress' },
  ]
  const ready = readyTasks(tasks, 100)
  assert(ready.length === 1 && ready[0].id === 'ready', `就绪任务异常: ${ready.map((task) => task.id)}`)
})

await check('recoverExpiredTasks: 按剩余尝试次数恢复或失败', () => {
  const tasks: TeamTask[] = [
    { id: 'retry', title: '可重试', status: 'in_progress', attempt: 1, maxAttempts: 2, leaseId: 'l1', leaseExpiresAt: 10 },
    { id: 'failed', title: '已耗尽', status: 'in_progress', attempt: 2, maxAttempts: 2, leaseId: 'l2', leaseExpiresAt: 10 },
    { id: 'active', title: '未过期', status: 'in_progress', attempt: 1, maxAttempts: 2, leaseId: 'l3', leaseExpiresAt: 30 },
  ]
  const recovered = recoverExpiredTasks(tasks, 20)
  assert(recovered.length === 2, `恢复数量异常: ${recovered.length}`)
  assert(tasks[0].status === 'todo' && tasks[0].nextRetryAt === 20, '可重试任务状态异常')
  assert(tasks[1].status === 'failed' && tasks[1].nextRetryAt === undefined, '耗尽任务状态异常')
  assert(tasks[2].status === 'in_progress' && tasks[2].leaseId === 'l3', '未过期任务被修改')
  assert(tasks[0].leaseId === undefined && Boolean(tasks[0].lastError), '恢复任务未清理租约')
})

await check('mergeTeamWorktrees: 无 worktree 时逐成员跳过', async () => {
  const group: TeamGroup = {
    name: 'team',
    lead: 'lead',
    members: [
      { name: 'alice', role: 'worker', workdir: 'a', backend: 'coroutine', needsApproval: false, status: 'idle' },
      { name: 'bob', role: 'worker', workdir: 'b', backend: 'coroutine', needsApproval: false, status: 'idle' },
    ],
  }
  const result = await mergeTeamWorktrees(group, null, '.')
  assert(result.success && result.output.includes('alice') && result.output.includes('bob'), '未返回全部成员的跳过结果')
})

await check('mergeTeamWorktrees: 主仓库脏状态拒绝合并', async () => {
  const root = join(import.meta.dirname, 'fixtures_team_merge_preflight')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  spawnSync('git', ['init', '-b', 'feature'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'clean', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: root })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'dirty', 'utf8')
  const group: TeamGroup = { name: 'dirty', lead: 'lead', members: [] }
  const result = await mergeTeamWorktrees(group, { exit: async () => { throw new Error('不应执行') } } as never, root)
  assert(!result.success && result.output.includes('主仓库存在未提交修改'), `脏仓库未拒绝合并: ${result.output}`)
  rmSync(root, { recursive: true, force: true })
})

await check('mergeTeamWorktrees: 冲突预演不产生主仓库部分合并', async () => {
  const root = join(import.meta.dirname, 'fixtures_team_merge_atomic')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'shared.txt'), 'base\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: root })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { cwd: root })
  const manager = new WorktreeManager(root)
  const alice = await manager.create('member-alice')
  const bob = await manager.create('member-bob')
  writeFileSync(join(alice.path, 'shared.txt'), 'alice\n', 'utf8')
  writeFileSync(join(bob.path, 'shared.txt'), 'bob\n', 'utf8')
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
  const group: TeamGroup = {
    name: 'atomic',
    lead: 'lead',
    members: [
      { name: 'alice', role: 'worker', workdir: alice.path, backend: 'coroutine', needsApproval: false, status: 'idle' },
      { name: 'bob', role: 'worker', workdir: bob.path, backend: 'coroutine', needsApproval: false, status: 'idle' },
    ],
  }
  const result = await mergeTeamWorktrees(group, manager, root)
  const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
  assert(!result.success && result.output.includes('冲突'), `冲突合并未失败: ${result.output}`)
  assert(before === after && readFileSync(join(root, 'shared.txt'), 'utf8') === 'base\n', '冲突预演修改了主仓库')
  await manager.remove('member-alice')
  await manager.remove('member-bob')
  rmSync(root, { recursive: true, force: true })
})

console.log(`\nteam_graph_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
