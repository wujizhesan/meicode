import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { createLeadTools } from '../src/team/lead-tools.ts'
import { TeamMail } from '../src/team/mail.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function fixture() {
  let models = 0, effects = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    if (++models % 2 === 1) yield { type: 'tool_call', id: 'effect-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'ARGUMENTS-VALID' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), root = join(f.root, 'team'), ctx = { ...f.chat.getToolContext(), agentId: 'lead-agent' }
  const team = new TeamManager(root, f.root, { provider, registry: f.registry, ctx }), store = new TeamGroupStore(root)
  const group = team.createGroup('audit', 'lead')
  await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
  f.registry.register({ name: 'write_file', description: '参数回归真实写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(join(f.root, 'effect.log'), 'EFFECT\n'); return { success: true, output: 'SAVED' }
  } })
  const original = team.addTask('audit', 'ORIGINAL')
  store.updateTask('audit', original.id, { updatedAt: 1 })
  const file = join(root, 'audit', 'tasks.json'), before = fs.readFileSync(file)
  return { ...f, team, store, group, original, file, before, context: { cwd: group.members[0].workdir, agentId: 'alice-agent' },
    worker: team.memberTools().find((tool) => tool.name === 'team_task')!,
    lead: createLeadTools(team).find((tool) => tool.name === 'team_assign')!,
    get models() { return models }, get effects() { return effects },
    unchanged() { assert(fs.readFileSync(file).equals(before)); assert.equal(models, 0); assert.equal(effects, 0); assert(!fs.existsSync(join(f.root, 'effect.log'))) },
    async close() { await team.close(1000); await f.close() },
  }
}
const invalidOptions = [
  { name: '依赖格式错误', field: 'depends_on', values: [null, 'missing', 7, {}, [null], [undefined], [true], ['missing', 7], [''], ['  '], Array(1)] },
  { name: '重试次数非法', field: 'max_attempts', values: [0, -1, 1.5, NaN, Infinity, '2', null, true, 101] },
  { name: '标题格式非法', field: 'title', values: [42, null, {}, ['TITLE'], true, '', '  ', 'x'.repeat(4001)] },
  { name: '目标格式非法', field: 'assignee', values: [['alice'], 42, null, {}, '', '  '] },
  { name: '入口字段非法', field: 'action', values: [['create'], ['audit'], null, 7, {}] },
]
for (const mode of ['member', 'lead']) for (const scenario of invalidOptions) {
  await check(`${mode} ${scenario.name} 失败前不创建任务或执行写入`, async () => {
    const f = await fixture()
    try {
      for (const value of scenario.values) {
        const args: Record<string, unknown> = mode === 'member'
          ? { action: 'create', title: 'INVALID-CREATE' }
          : { group: 'audit', member: 'alice', task: 'INVALID-ASSIGN' }
        const field = mode === 'lead' && scenario.field === 'title' ? 'task'
          : mode === 'lead' && scenario.field === 'assignee' ? 'member'
          : mode === 'lead' && scenario.field === 'action' ? 'group' : scenario.field
        args[field] = value
        const result = await bounded((mode === 'member' ? f.worker : f.lead).execute(args, mode === 'member' ? f.context : f.chat.getToolContext()))
        assert.equal(result.success, false, JSON.stringify({ field, value, output: result.output }))
        assert(result.error)
        f.unchanged()
      }
    } finally { await f.close() }
  })
}
for (const field of ['id', 'status', 'result', 'empty']) {
  await check(`成员更新 ${field} 非法时整个请求失败且不改时间戳`, async () => {
    const f = await fixture()
    try {
      const inputs = field === 'id' ? [[f.original.id], { id: f.original.id }, 7, null]
        : field === 'status' ? [true, null, 7, ['done'], 'unknown']
        : field === 'result' ? [true, null, 7, ['RESULT'], {}] : [undefined]
      for (const value of inputs) {
        const args: Record<string, unknown> = { action: 'update', id: f.original.id }
        if (field === 'id') { args.id = value; args.result = 'SHOULD-NOT-SAVE' }
        if (field === 'status') { args.status = value; args.result = 'SHOULD-NOT-SAVE' }
        if (field === 'result') { args.result = value; args.status = 'done' }
        const result = await f.worker.execute(args, f.context)
        assert.equal(result.success, false, field + ' ' + String(value))
        assert(result.error)
        f.unchanged()
      }
    } finally { await f.close() }
  })
}
await check('直接创建 API 拒绝小数次数和错误依赖，原任务保持不变', async () => {
  const f = await fixture()
  try {
    for (const maximum of [1.5, 2.9, NaN, Infinity, 0, 101]) {
      assert.throws(() => f.team.addTask('audit', 'INVALID-API', 'alice', [], maximum))
      f.unchanged()
    }
    for (const dependencies of ['missing', null, ['missing', true]]) {
      assert.throws(() => f.team.addTask('audit', 'INVALID-API', 'alice', dependencies as never))
      f.unchanged()
    }
  } finally { await f.close() }
})
await check('直接更新 API 拒绝空更新和混合错误字段，原任务保持不变', async () => {
  const f = await fixture()
  const scheduler = new TeamTaskScheduler({ store: f.store, mail: new TeamMail(join(f.root, 'direct-mail')),
    members: new Map(), memberGroups: new Map([['alice', 'audit']]), ctx: f.chat.getToolContext() })
  try {
    for (const patch of [{}, { status: null, result: 'SHOULD-NOT-SAVE' }, { status: 'done', result: false }, { status: 'unknown' }]) {
      assert.throws(() => scheduler.updateTaskFromMember('audit', 'alice', f.original.id, patch))
      f.unchanged()
    }
  } finally { await scheduler.close(1000); await f.close() }
})
await check('省略创建选项仍有默认标题、成员和次数，可真实执行一次', async () => {
  const f = await fixture()
  try {
    const result = await f.worker.execute({ action: 'create' }, f.context)
    assert.equal(result.success, true)
    const task = f.store.listTasks('audit').find((task) => task.id !== f.original.id)!
    assert.equal(task.title, '未命名'); assert.equal(task.assignee, 'alice'); assert.equal(task.maxAttempts, 1)
    await bounded(f.team.runTask(f.group, task, 'alice'))
    assert.equal(f.store.listTasks('audit').find((item) => item.id === task.id)?.status, 'done')
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
    assert.equal(fs.readFileSync(join(f.root, 'effect.log'), 'utf8'), 'EFFECT\n')
  } finally { await f.close() }
})
await check('合法整数上限与重复依赖保持可用，完成依赖后派发真实任务', async () => {
  const f = await fixture()
  try {
    const result = await f.lead.execute({ group: 'audit', member: 'alice', task: 'VALID-DEPENDENT', depends_on: [f.original.id, f.original.id], max_attempts: 100 }, f.chat.getToolContext())
    assert.equal(result.success, true)
    const task = f.store.listTasks('audit').find((item) => item.id !== f.original.id)!
    assert.deepEqual(task.depends_on, [f.original.id]); assert.equal(task.maxAttempts, 100)
    assert.equal(task.status, 'todo'); assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal((await f.worker.execute({ action: 'update', id: f.original.id, status: 'done', result: 'DEPENDENCY-DONE' }, f.context)).success, true)
    const deadline = Date.now() + 2500
    while (f.store.listTasks('audit').find((item) => item.id === task.id)?.status !== 'done' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    assert.equal(f.store.listTasks('audit').find((item) => item.id === task.id)?.status, 'done')
    assert.equal(f.models, 2); assert.equal(f.effects, 1)
  } finally { await f.close() }
})
await check('合法更新允许空字符串结果，只保存明确传入的字段', async () => {
  const f = await fixture()
  try {
    const result = await f.worker.execute({ action: 'update', id: f.original.id, result: '' }, f.context)
    assert.equal(result.success, true)
    const current = f.store.listTasks('audit')[0]
    assert.equal(current.result, ''); assert.equal(current.status, 'todo')
    assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})
console.log(`团队任务参数: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
