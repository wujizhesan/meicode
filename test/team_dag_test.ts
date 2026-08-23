import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TeamManager } from '../src/team/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import type { ToolContext } from '../src/tools/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: '任务完成' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_team_dag')
const repo = join(root, 'repo')
rmSync(root, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })

const ctx: ToolContext = { cwd: repo }
const manager = new TeamManager(join(root, 'team'), repo, {
  provider: new FakeProvider(),
  registry: { toOpenAITools: () => [] } as never,
  ctx,
})
const group = manager.createGroup('dag', 'lead')
const member = await manager.spawnMember(group, 'alice', 'worker', { workdir: repo })
const first = manager.addTask(group.name, '第一阶段')
const second = manager.addTask(group.name, '第二阶段', 'alice', [first.id], 2)
const third = manager.addTask(group.name, '第三阶段', 'alice', [second.id], 1)

if (!manager.listReadyTasks(group.name).some((task) => task.id === first.id)) throw new Error('首个任务未就绪')
if (manager.listReadyTasks(group.name).some((task) => task.id === second.id)) throw new Error('依赖未完成却被标记为就绪')
if (!manager.taskBlockers(group.name, second).includes(first.id)) throw new Error('依赖阻塞信息缺失')
if (!member || !manager.getMember('alice')) throw new Error('成员未创建')

const blocked = await manager.runTask(group, second, 'alice')
if (!blocked.includes('阻塞')) throw new Error('未阻止提前执行依赖任务')

await manager.runTask(group, first, 'alice')
if (manager.listTasks(group.name).find((task) => task.id === first.id)?.status !== 'done') throw new Error('第一阶段未完成')
await new Promise((resolve) => setTimeout(resolve, 250))
const completed = manager.listTasks(group.name).find((task) => task.id === second.id)
if (completed?.status !== 'done' || !completed.reportId || completed.report?.status !== 'done') throw new Error('结构化报告未回写')
if (!completed.report?.tokens && completed.report?.tokens !== 0) throw new Error('报告缺少 token 统计')
await new Promise((resolve) => setTimeout(resolve, 250))
if (manager.listTasks(group.name).find((task) => task.id === third.id)?.status !== 'done') throw new Error('下游任务未被自动调度')

let rejected = false
try {
  manager.addTask(group.name, '非法依赖', undefined, ['missing-task'])
} catch {
  rejected = true
}
if (!rejected) throw new Error('不存在的依赖未被拒绝')

rmSync(root, { recursive: true, force: true })
console.log('team_dag_test passed')
