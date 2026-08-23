import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import type { ToolContext } from '../src/tools/index.ts'

class FlakyProvider implements Provider {
  readonly protocol = 'openai' as const
  private calls = 0

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.calls++
    if (this.calls === 1) throw new Error('temporary failure')
    yield { type: 'text', text: 'retry succeeded' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_team_recovery')
const repo = join(root, 'repo')
rmSync(root, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
const ctx: ToolContext = { cwd: repo }
const provider = new FlakyProvider()
const manager = new TeamManager(join(root, 'team'), repo, { provider, registry: { toOpenAITools: () => [] } as never, ctx })
const group = manager.createGroup('retry', 'lead')
await manager.spawnMember(group, 'alice', 'worker', { workdir: repo })
const task = manager.addTask(group.name, '可重试任务', 'alice', [], 2)
await manager.runTask(group, task, 'alice')
await new Promise((resolve) => setTimeout(resolve, 1500))
const retried = manager.listTasks(group.name).find((item) => item.id === task.id)
if (retried?.status !== 'done' || retried.attempt !== 2) throw new Error('失败任务未自动重试')

const store = new TeamGroupStore(join(root, 'recovery-team'))
store.createGroup('recover', 'lead')
store.saveTasks('recover', [{ id: 'stale', title: '陈旧任务', status: 'in_progress', attempt: 1, maxAttempts: 2, leaseId: 'lease_old', leaseExpiresAt: 10 }])
const recoveryManager = new TeamManager(join(root, 'recovery-team'), repo, { provider, registry: { toOpenAITools: () => [] } as never, ctx })
const recovered = recoveryManager.recoverStaleTasks('recover', 20)
if (recovered.length !== 1 || recovered[0].status !== 'todo' || !recovered[0].lastError || recovered[0].nextRetryAt !== 20) {
  throw new Error('陈旧任务恢复状态错误')
}

rmSync(root, { recursive: true, force: true })
console.log('team_recovery_test passed')
