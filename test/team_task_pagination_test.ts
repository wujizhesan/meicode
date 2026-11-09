import { createLeadTools } from '../src/team/lead-tools.ts'
import { createMemberTools, type MemberToolServices } from '../src/team/member-tools.ts'
import type { TeamManager } from '../src/team/index.ts'
import type { TeamGroup, TeamMember, TeamTask } from '../src/team/types.ts'

const member: TeamMember = { name: 'alice', role: 'worker', workdir: process.cwd(), backend: 'coroutine', needsApproval: false, status: 'idle' }
const group: TeamGroup = { name: 'bench', lead: 'lead', members: [member] }
const tasks: TeamTask[] = Array.from({ length: 120 }, (_, index) => ({
  id: `t${index}`,
  title: `title-${index} ${'A'.repeat(1000)}`,
  status: index % 3 === 0 ? 'done' : 'todo',
  assignee: 'alice',
  result: `result-${index} ${'B'.repeat(4000)}`,
}))
const lead = createLeadTools({ loadGroup: () => group, listTasks: () => tasks } as unknown as TeamManager).find((tool) => tool.name === 'team_tasks')!
const services: MemberToolServices = {
  resolveMember: () => ({ group, member }),
  isLeadContext: () => false,
  listTasks: () => tasks,
  addTask: () => { throw new Error('unexpected create') },
  updateTask: () => null,
  sendMail: () => {},
}
const worker = createMemberTools(services).find((tool) => tool.name === 'team_task')!
const context = { cwd: process.cwd() }

const first = await lead.execute({ group: group.name }, context)
const firstIds = [...first.output.matchAll(/^ {2}(t\d+) \[/gm)].map((match) => match[1])
if (!first.success || firstIds.length !== 50 || firstIds[0] !== 't119' || firstIds[49] !== 't70' || first.output.length > 25000) {
  throw new Error('Lead 任务列表默认页未限制数量或摘要')
}

let args: Record<string, unknown> | undefined = { group: group.name, status: 'done', limit: 10 }
const doneIds: string[] = []
while (args) {
  const result = await lead.execute(args, context)
  if (!result.success) throw new Error(`Lead 状态分页失败: ${result.error}`)
  doneIds.push(...[...result.output.matchAll(/^ {2}(t\d+) \[/gm)].map((match) => match[1]))
  const next = result.output.match(/^下一页参数：(.*)$/m)
  args = next ? JSON.parse(next[1]) as Record<string, unknown> : undefined
}
if (doneIds.length !== 40 || new Set(doneIds).size !== 40 || doneIds[0] !== 't117' || doneIds[39] !== 't0') {
  throw new Error('Lead 状态筛选分页存在重复或遗漏')
}

const beforeAppend = await lead.execute({ group: group.name, limit: 2 }, context)
const nextParams = beforeAppend.output.match(/^下一页参数：(.*)$/m)
if (!nextParams) throw new Error('Lead 列表未提供下一页游标')
tasks.push({ id: 't120', title: 'new task', status: 'todo' })
const afterAppend = await lead.execute(JSON.parse(nextParams[1]) as Record<string, unknown>, context)
const afterIds = [...afterAppend.output.matchAll(/^ {2}(t\d+) \[/gm)].map((match) => match[1])
if (afterIds.join(',') !== 't117,t116') throw new Error('新增任务使 Lead 游标重复或跳过任务')

const detail = await lead.execute({ group: group.name, id: 't42' }, context)
if (!detail.success || (JSON.parse(detail.output) as TeamTask).result !== tasks[42].result) throw new Error('Lead 按 ID 查看完整任务失败')
const workerList = await worker.execute({ action: 'list' }, context)
const workerPage = JSON.parse(workerList.output) as { tasks: Array<{ id: string; resultPreview?: string }>; next?: { cursor: string } }
if (!workerList.success || workerPage.tasks.length !== 50 || workerPage.tasks[0].id !== 't120' || !workerPage.next || workerList.output.length > 30000) {
  throw new Error('成员任务列表默认页未限制数量或摘要')
}
const workerNext = await worker.execute({ action: 'list', limit: 50, cursor: workerPage.next.cursor }, context)
const workerNextPage = JSON.parse(workerNext.output) as { tasks: Array<{ id: string }> }
if (!workerNext.success || workerNextPage.tasks[0]?.id !== 't70') throw new Error('成员任务分页游标错误')
const workerDetail = await worker.execute({ action: 'get', id: 't42' }, context)
if (!workerDetail.success || (JSON.parse(workerDetail.output) as TeamTask).result !== tasks[42].result) throw new Error('成员按 ID 查看完整任务失败')

for (const invalid of [{ limit: 101 }, { status: 'unknown' }, { cursor: 'bad' }]) {
  const leadResult = await lead.execute({ group: group.name, ...invalid }, context)
  const workerResult = await worker.execute({ action: 'list', ...invalid }, context)
  if (leadResult.success || workerResult.success) throw new Error('非法任务分页参数未被两个入口拒绝')
}

console.log('team_task_pagination_test passed')
