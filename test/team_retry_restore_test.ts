import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
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

const options = { provider: new FakeProvider(), registry: { toOpenAITools: () => [] } as never, ctx: { cwd: repo } }
const first = new TeamManager(join(root, 'team'), repo, options)
const group = first.createGroup('retry', 'lead')
await first.spawnMember(group, 'alice', 'worker', { workdir: repo })
const store = new TeamGroupStore(join(root, 'team'))
store.saveTasks('retry', [{ id: 'retry-1', title: '重启后重试', assignee: 'alice', status: 'todo', attempt: 1, maxAttempts: 2, nextRetryAt: Date.now() + 30 }])

const restored = new TeamManager(join(root, 'team'), repo, options)
await restored.restore()
await new Promise((resolve) => setTimeout(resolve, 250))
const task = restored.listTasks('retry').find((item) => item.id === 'retry-1')
if (task?.status !== 'done') throw new Error(`重启后待重试任务未执行: ${task?.status}`)

rmSync(root, { recursive: true, force: true })
console.log('team_retry_restore_test passed')
