// 审批流自动化测试：needsApproval 成员 PLAN→APPROVE/DENY 全链路 + planTs 时效
import { TeamManager } from '../src/team/index.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}: ${(e as Error).message}`)
  }
}
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg)
}

const TMP = join(import.meta.dirname, 'fixtures_approval')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const ctx = { cwd: join(TMP, 'repo') }
mkdirSync(ctx.cwd, { recursive: true })

// 成员执行时不真调 API：返回固定文本
const fakeProvider = {
  protocol: 'openai' as const,
  async *streamChat() {
    yield { type: 'text' as const, text: '成员执行完成的结果' }
    yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
    yield { type: 'done' as const }
  },
}

async function setup(needsApproval: boolean): Promise<{ manager: TeamManager; group: ReturnType<TeamManager['createGroup']> }> {
  // 唯一 teamDir:每个 check 独立(防前序测试的 PLAN/APPROVE 邮件残留)
  const manager = new TeamManager(join(TMP, `team-${Date.now().toString(36)}`), ctx.cwd, {
    provider: fakeProvider as never,
    registry: { toOpenAITools: () => [] } as never,
    ctx,
  })
  const group = manager.createGroup(`g${Date.now().toString(36)}`, 'lead')
  await manager.spawnMember(group, 'alice', 'worker', { needsApproval })
  return { manager, group }
}

await check('审批: APPROVE 后成员执行完成(done)', async () => {
  const { manager, group } = await setup(true)
  const task = manager.addTask(group.name, '写文档', 'alice')
  const assignPromise = manager.assignTask(group, task, 'alice')
  // 等 PLAN 到达 + Lead 审批
  await new Promise((r) => setTimeout(r, 1600))
  const mails = manager.readLeadMail()
  assert(mails.some((m) => m.body.startsWith('PLAN')), 'Lead 未收到 PLAN')
  manager.respondApproval(group.name, 'alice', true, '可以')
  await assignPromise
  await new Promise((r) => setTimeout(r, 1000))
  const t = manager.listTasks(group.name).find((x) => x.id === task.id)
  assert(t?.status === 'done', `应为 done,实际 ${t?.status}`)
  assert(String(t?.result).includes('成员执行完成'), '结果缺失')
})

await check('审批: DENY 后任务 failed + 拒绝原因', async () => {
  const { manager, group } = await setup(true)
  const task = manager.addTask(group.name, '危险操作', 'alice')
  const assignPromise = manager.assignTask(group, task, 'alice')
  await new Promise((r) => setTimeout(r, 1600))
  manager.respondApproval(group.name, 'alice', false, '不能做')
  await assignPromise
  await new Promise((r) => setTimeout(r, 1400))
  const t = manager.listTasks(group.name).find((x) => x.id === task.id)
  assert(t?.status === 'failed', `应为 failed,实际 ${t?.status}`)
  assert(String(t?.result).includes('拒绝'), '拒绝原因缺失')
})

await check('审批: planTs 时效——历史 APPROVE 不被后续任务复用', async () => {
  const { manager, group } = await setup(true)
  // 任务 1：APPROVE → done
  const t1 = manager.addTask(group.name, '任务1', 'alice')
  const p1 = manager.assignTask(group, t1, 'alice')
  await new Promise((r) => setTimeout(r, 1600))
  const plan1 = manager.readLeadMail().find((message) => message.kind === 'approval_plan' && message.taskId === t1.id)
  assert(plan1?.correlationId, '任务1 PLAN 缺少审批关联')
  manager.respondApproval(group.name, 'alice', true, 'ok', t1.id, plan1?.correlationId)
  await p1
  await new Promise((r) => setTimeout(r, 1400))
  // 任务 2：不审批，历史 APPROVE 不应被复用 → 等超时(60s 太长，缩短验证：确认 2s 后仍是 in_progress)
  const t2 = manager.addTask(group.name, '任务2', 'alice')
  const p2 = manager.assignTask(group, t2, 'alice')
  await new Promise((r) => setTimeout(r, 1600))
  const stale = manager.respondApproval(group.name, 'alice', true, '迟到批准', t1.id, plan1?.correlationId)
  assert(stale.startsWith('审批失败:'), `旧任务审批未被拒绝: ${stale}`)
  const st = manager.listTasks(group.name).find((x) => x.id === t2.id)?.status
  assert(st === 'in_progress', `历史 APPROVE 被误复用(任务2 提前完成),状态 ${st}`)
  // 清理：审批让它完成
  const plan2 = manager.readLeadMail().find((message) => message.kind === 'approval_plan' && message.taskId === t2.id)
  assert(plan2?.correlationId && plan2.correlationId !== plan1?.correlationId, '任务2 未生成独立审批关联')
  manager.respondApproval(group.name, 'alice', true, '现在批准', t2.id, plan2?.correlationId)
  await p2
})

await check('审批: 非 needsApproval 成员直接执行(无 PLAN)', async () => {
  const { manager, group } = await setup(false)
  const task = manager.addTask(group.name, '直接干', 'alice')
  const assignPromise = manager.assignTask(group, task, 'alice')
  await assignPromise
  await new Promise((r) => setTimeout(r, 1400))
  const t = manager.listTasks(group.name).find((x) => x.id === task.id)
  assert(t?.status === 'done', '普通成员应直接 done')
  assert(!manager.readLeadMail().some((m) => m.body.startsWith('PLAN')), '普通成员不应发 PLAN')
})

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  // Windows 偶发占用忽略
}
console.log(`\napproval_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
