import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TeamManager } from '../src/team/index.ts'
import type { ToolContext } from '../src/tools/index.ts'

const root = join(import.meta.dirname, 'fixtures_worktree_isolation')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const repo = join(root, 'repo')
mkdirSync(repo, { recursive: true })
const ctx: ToolContext = { cwd: repo }
const failingWorktrees = { create: async () => { throw new Error('git unavailable') } }
const manager = new TeamManager(join(root, 'team'), repo, { provider: {} as never, registry: { toOpenAITools: () => [] } as never, ctx }, failingWorktrees as never)
const group = manager.createGroup('secure', 'lead')
let rejected = false
try {
  await manager.spawnMember(group, 'alice', 'worker')
} catch (e) {
  rejected = String(e).includes('已拒绝无隔离启动')
}
if (!rejected) throw new Error('Worktree 创建失败时未拒绝降级启动')
if (manager.loadGroup('secure')?.members.length !== 0) throw new Error('隔离失败成员不应写入持久化组状态')

rmSync(root, { recursive: true, force: true })
console.log('worktree_isolation_test passed')
