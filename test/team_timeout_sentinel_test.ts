import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TeamManager } from '../src/team/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'

class SentinelProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: '__TIMEOUT__' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_team_timeout_sentinel')
const repo = join(root, 'repo')
rmSync(root, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })

const manager = new TeamManager(join(root, 'team'), repo, {
  provider: new SentinelProvider(),
  registry: { toOpenAITools: () => [] } as never,
  ctx: { cwd: repo },
})
const group = manager.createGroup('sentinel', 'lead')
await manager.spawnMember(group, 'alice', 'worker', { workdir: repo })
const task = manager.addTask(group.name, '返回超时哨兵文本', 'alice')
const result = await manager.runTask(group, task, 'alice')

if (result !== '__TIMEOUT__') throw new Error(`正常结果被误判为超时: ${result}`)
if (manager.listTasks(group.name).find((item) => item.id === task.id)?.status !== 'done') {
  throw new Error('哨兵文本任务未正常完成')
}

await manager.close()
rmSync(root, { recursive: true, force: true })
console.log('team_timeout_sentinel_test passed')
