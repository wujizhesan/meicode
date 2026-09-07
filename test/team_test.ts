// 团队系统测试：小组/邮箱锁/任务/成员/coordinator/协议
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { TeamManager, TeamGroupStore, TeamMail } from '../src/team/index.ts'
import { withLock } from '../src/team/lock.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { ToolContext } from '../src/tools/index.ts'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

const TMP = join(import.meta.dirname, 'fixtures_team')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const TEAM_ROOT = join(TMP, 'team')
const REPO = join(TMP, 'repo')
mkdirSync(REPO, { recursive: true })

class FakeTeamProvider implements Provider {
  readonly protocol = 'openai' as const
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: '成员任务完成' }
    yield { type: 'done' }
  }
}

// 协程死亡模拟：streamChat 抛异常 → 成员 execute reject → 应触发 ERR 邮件
class ThrowingTeamProvider implements Provider {
  readonly protocol = 'openai' as const
  async *streamChat(): AsyncGenerator<StreamEvent> {
    throw new Error('模拟协程死亡')
  }
}

const ctx: ToolContext = { cwd: REPO }

async function main() {
  // ---------- 小组持久化 ----------
  await check('小组: 创建与加载', () => {
    const store = new TeamGroupStore(TEAM_ROOT)
    const g = store.createGroup('dev', 'lead1')
    store.addMember(g, { name: 'alice', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' })
    const loaded = store.loadGroup('dev')
    if (!loaded || loaded.lead !== 'lead1' || loaded.members.length !== 1) throw new Error('加载失败')
    if (!existsSync(join(TEAM_ROOT, 'dev', 'tasks.json'))) throw new Error('tasks.json 缺失')
    if (store.loadGroup('../outside') !== null) throw new Error('非法团队名称未拒绝')
    let rejected = false
    try {
      store.createGroup('../outside', 'lead1')
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('创建非法团队名称未拒绝')
  })
  await check('小组: 任务 CRUD 持久化', () => {
    const store = new TeamGroupStore(TEAM_ROOT)
    store.saveTasks('dev', [{ id: 't1', title: '任务A', status: 'todo', depends_on: ['t2'] }])
    const tasks = store.listTasks('dev')
    if (tasks.length !== 1 || tasks[0].depends_on?.[0] !== 't2') throw new Error('任务持久化失败')
    const updated = store.updateTask('dev', 't1', { status: 'done', result: 'ok' })
    if (!updated || updated.status !== 'done') throw new Error('任务更新失败')
    store.saveTasks('dev', [{ id: 'claim-1', title: '领取竞争', status: 'todo' }])
    const firstClaim = store.claimTask('dev', 'claim-1', { status: 'in_progress', attempt: 1 })
    const secondClaim = new TeamGroupStore(TEAM_ROOT).claimTask('dev', 'claim-1', { status: 'in_progress', attempt: 2 })
    const staleA = new TeamGroupStore(TEAM_ROOT)
    const staleB = new TeamGroupStore(TEAM_ROOT)
    const snapshotA = staleA.loadGroup('dev')
    const snapshotB = staleB.loadGroup('dev')
    if (!snapshotA || !snapshotB) throw new Error('成员快照读取失败')
    staleA.addMember(snapshotA, { name: 'bob', agentId: 'agent-bob', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' })
    staleB.addMember(snapshotB, { name: 'carol', agentId: 'agent-carol', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' })
    const membersAfterRace = store.loadGroup('dev')?.members ?? []
    if (!membersAfterRace.some((member) => member.name === 'bob') || !membersAfterRace.some((member) => member.name === 'carol')) throw new Error('成员原子注册覆盖了并发成员')
    const manager = new TeamManager(TEAM_ROOT, REPO, { provider: new FakeTeamProvider(), registry: { toOpenAITools: () => [] } as never, ctx })
    const appended = manager.addTask('dev', 'atomic append')
    if (!store.listTasks('dev').some((task) => task.id === appended.id)) throw new Error('任务原子追加失败')
    store.saveTasks('dev', [
      { id: 'stale', title: 'stale', status: 'in_progress', attempt: 1, maxAttempts: 2, leaseId: 'old', leaseExpiresAt: 10 },
      { id: 'fresh', title: 'fresh', status: 'todo' },
    ])
    const recovered = manager.recoverStaleTasks('dev', 20)
    const afterRecovery = store.listTasks('dev')
    if (recovered.length !== 1 || afterRecovery.length !== 2 || afterRecovery.find((task) => task.id === 'fresh')?.status !== 'todo') throw new Error('过期任务恢复覆盖了其他任务')
    if (!firstClaim || secondClaim) throw new Error('任务条件领取未串行化')
  })

  // ---------- 邮箱 ----------
  await check('邮箱: 点对点/已读/时间戳/摘要', () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'mail'))
    mail.register('alice')
    mail.register('bob')
    mail.send('bob', 'alice', '第一条消息内容较长用于摘要截断验证')
    const msgs = mail.read('alice')
    if (msgs.length !== 1 || msgs[0].from !== 'bob') throw new Error('读取失败')
    if (!msgs[0].ts || msgs[0].read !== false) throw new Error('时间戳/已读默认值缺失')
    if (!msgs[0].summary || msgs[0].summary.length > 80) throw new Error('摘要截断失败')
    mail.read('alice', true)
    if (!mail.read('alice')[0].read) throw new Error('已读标记失败')
    if (mail.read('../outside').length !== 0) throw new Error('非法邮箱名称未拒绝')
  })
  await check('邮箱: 广播', () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'mail'))
    mail.send('lead', '*', '全员通知')
    const msgs = mail.read('alice')
    if (!msgs.some((m) => m.to === '*')) throw new Error('广播未收到')
    mail.read('alice', true)
    const broadcast = mail.read('alice').find((m) => m.body === '全员通知')
    if (!broadcast?.read) throw new Error('广播已读状态未落盘')
  })
  await check('邮箱: 事件等待消息', async () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'wait-mail'))
    mail.register('alice')
    const pending = mail.waitForMessage('alice', (message) => message.body === 'wake', 1000)
    setTimeout(() => mail.send('lead', 'alice', 'wake'), 20)
    const message = await pending
    if (!message || message.body !== 'wake') throw new Error('邮件事件等待未唤醒')
  })
  await check('邮箱: 多等待者共享监听并独立唤醒', async () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'multi-wait-mail'))
    mail.register('alice')
    mail.register('bob')
    const alice = mail.waitForMessage('alice', (message) => message.body === 'for-alice', 1000)
    const bob = mail.waitForMessage('bob', (message) => message.body === 'for-bob', 1000)
    mail.send('lead', 'alice', 'for-alice')
    mail.send('lead', 'bob', 'for-bob')
    const [aliceMessage, bobMessage] = await Promise.all([alice, bob])
    if (aliceMessage?.body !== 'for-alice' || bobMessage?.body !== 'for-bob') {
      throw new Error('多个邮件等待者未独立唤醒')
    }
  })
  await check('邮件等待支持取消', async () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'abort-mail'))
    mail.register('alice')
    const controller = new AbortController()
    const pending = mail.waitForMessage('alice', () => true, 5000, controller.signal)
    controller.abort()
    if (await pending !== null) throw new Error('邮件等待取消失败')
  })
  await check('邮箱: 锁并发与过期', () => {
    // 锁：同锁文件串行不冲突
    let counter = 0
    withLock(join(TMP, 'test.lock'), () => {
      counter++
    })
    withLock(join(TMP, 'test.lock'), () => {
      counter++
    })
    if (counter !== 2) throw new Error('锁串行失败')
    // 过期锁：伪造旧锁 → 覆盖
    writeFileSync(join(TMP, 'stale.lock'), String(Date.now() - 60000), 'utf8')
    let executed = false
    withLock(join(TMP, 'stale.lock'), () => {
      executed = true
    })
    if (!executed) throw new Error('过期锁未覆盖')
    const waitLock = join(TMP, 'wait.lock')
    const holder = spawn(process.execPath, ['-e', `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(waitLock)}, String(Date.now())); setTimeout(() => fs.unlinkSync(${JSON.stringify(waitLock)}), 500)`], { stdio: 'ignore' })
    const deadline = Date.now() + 2000
    while (!existsSync(waitLock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    const started = Date.now()
    withLock(waitLock, () => {})
    if (Date.now() - started < 300) throw new Error('锁竞争未等待')
    holder.kill()
  })
  await check('邮箱: 协议解析', () => {
    const p1 = TeamMail.parseProtocol('APPROVE 计划可行')
    if (p1.type !== 'APPROVE') throw new Error('APPROVE 解析失败')
    const p2 = TeamMail.parseProtocol('PLAN 任务 t1')
    if (p2.type !== 'PLAN') throw new Error('PLAN 解析失败')
    const p3 = TeamMail.parseProtocol('PROTO:ping')
    if (p3.type !== 'PROTO') throw new Error('PROTO 解析失败')
    const p4 = TeamMail.parseProtocol('普通消息')
    if (p4.type !== 'TEXT') throw new Error('TEXT 解析失败')
  })

  // ---------- 协作工具 ----------
  await check('工具: team_task CRUD', async () => {
    const manager = new TeamManager(TEAM_ROOT, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('dev', 'lead')
    await manager.spawnMember(group, 'alice', 'worker')
    // memberTools 按 ctx.cwd 解析身份——无 worktree 时成员 workdir = process.cwd()
    const memberCtx = { ...ctx, cwd: process.cwd() }
    const tools = manager.memberTools()
    const taskTool = tools.find((t) => t.name === 'team_task')!
    const r1 = await taskTool.execute({ action: 'create', title: '写文档', assignee: 'alice' }, memberCtx)
    if (!r1.success) throw new Error(`创建失败: ${r1.error}`)
    const r2 = await taskTool.execute({ action: 'list' }, memberCtx)
    if (!r2.output.includes('写文档')) throw new Error('列表缺失')
    const id = r1.output.match(/t\w+/)?.[0] ?? ''
    const r3 = await taskTool.execute({ action: 'update', id, status: 'done', result: '完成' }, memberCtx)
    if (!r3.success) throw new Error('更新失败')
  })
  await check('工具: team_send 落盘', async () => {
    const manager = new TeamManager(TEAM_ROOT, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('dev2', 'lead')
    await manager.spawnMember(group, 'alice', 'worker')
    const memberCtx = { ...ctx, cwd: process.cwd() }
    const tools = manager.memberTools()
    const sendTool = tools.find((t) => t.name === 'team_send')!
    const r = await sendTool.execute({ to: 'bob', body: 'APPROVE 可以' }, memberCtx)
    if (!r.success) throw new Error('发送失败')
    const mail = new TeamMail(join(TEAM_ROOT, '_shared', 'mail'))
    const msgs = mail.read('bob')
    if (!msgs.some((m) => m.from === 'alice')) throw new Error('消息未落盘')
  })

  // ---------- TeamManager ----------
  await check('coordinator: 双锁缺一不生效', () => {
    const makeMgr = () =>
      new TeamManager(TEAM_ROOT, REPO, {
        provider: new FakeTeamProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx,
      })
    if (makeMgr().isCoordinator()) throw new Error('无配置+无env 不应生效')
    writeFileSync(join(TEAM_ROOT, 'team.yaml'), 'coordinator_enabled: true\n', 'utf8')
    if (makeMgr().isCoordinator()) throw new Error('有配置无env 不应生效')
    process.env.MEWCOORDINATOR = '1'
    if (!makeMgr().isCoordinator()) throw new Error('双锁应生效')
    delete process.env.MEWCOORDINATOR
    rmSync(join(TEAM_ROOT, 'team.yaml'), { force: true })
  })
  await check('coordinator: createLeadTools 过滤 write/edit', () => {
    const registry = {
      toOpenAITools: () => [
        { type: 'function', function: { name: 'read_file', description: 'd', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'write_file', description: 'd', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'edit_file', description: 'd', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'run_command', description: 'd', parameters: { type: 'object' } } },
      ],
    } as never
    writeFileSync(join(TEAM_ROOT, 'team.yaml'), 'coordinator_enabled: true\n', 'utf8')
    process.env.MEWCOORDINATOR = '1'
    const manager = new TeamManager(TEAM_ROOT, REPO, { provider: new FakeTeamProvider(), registry, ctx })
    const tools = manager.createLeadTools()
    if (!tools) throw new Error('coordinator 未生效')
    const names = tools.map((t) => t.function.name)
    if (names.includes('write_file') || names.includes('edit_file')) throw new Error('写工具未剥夺')
    if (!names.includes('read_file') || !names.includes('run_command')) throw new Error('读/命令被误删')
    delete process.env.MEWCOORDINATOR
  })
  await check('TeamManager: spawnMember + assignTask', async () => {
    const registry = {
      toOpenAITools: () => [],
    } as never
    const manager = new TeamManager(TEAM_ROOT, REPO, { provider: new FakeTeamProvider(), registry, ctx })
    // 共享产物区已创建（成员中间产物互通）
    if (!existsSync(join(REPO, '.mewcode', 'artifacts'))) throw new Error('共享产物区未创建')
    const group = manager.createGroup('build', 'lead')
    await manager.spawnMember(group, 'alice', 'worker')
    const tasks = manager.listTasks('build')
    const task = { id: 'bt1', title: '构建任务', status: 'todo' as const }
    tasks.push(task)
    manager['store'].saveTasks('build', tasks)
    const res = await manager.assignTask(group, task, 'alice')
    if (!res.includes('已指派')) throw new Error(`指派失败: ${res}`)
    await new Promise((r) => setTimeout(r, 500))
    const updated = manager.listTasks('build').find((t) => t.id === 'bt1')
    if (updated?.status !== 'done') throw new Error(`任务未完成: ${updated?.status}`)
  })
  await check('TeamManager: 协程死亡 → 任务 failed + ERR 邮件送达 Lead', async () => {
    const manager = new TeamManager(TEAM_ROOT, REPO, { provider: new ThrowingTeamProvider(), registry: { toOpenAITools: () => [] } as never, ctx })
    const group = manager.createGroup('death', 'lead')
    await manager.spawnMember(group, 'alice', 'worker')
    const tasks = manager.listTasks('death')
    const task = { id: 'dt1', title: '会失败的任务', status: 'todo' as const }
    tasks.push(task)
    manager['store'].saveTasks('death', tasks)
    await manager.assignTask(group, task, 'alice')
    await new Promise((r) => setTimeout(r, 500))
    const updated = manager.listTasks('death').find((t) => t.id === 'dt1')
    if (manager.getMember('alice')?.isBusy()) throw new Error('成员异常后未释放 busy 状态')
    if (updated?.status !== 'failed') throw new Error(`应 failed: ${updated?.status}`)
    const mail = new TeamMail(join(TEAM_ROOT, '_shared', 'mail'))
    const msgs = mail.read('lead')
    if (!msgs.some((m) => m.from === 'alice' && m.body.includes('ERR'))) {
      throw new Error('Lead 未收到 ERR 邮件(协程死亡静默)')
    }
  })
  await check('TeamManager: close 取消审批等待并清理成员', async () => {
    const manager = new TeamManager(TEAM_ROOT, REPO, { provider: new FakeTeamProvider(), registry: { toOpenAITools: () => [] } as never, ctx })
    const group = manager.createGroup('shutdown', 'lead')
    await manager.spawnMember(group, 'alice', 'worker', { needsApproval: true, workdir: REPO })
    const task = { id: 'shutdown-task', title: 'shutdown', status: 'todo' as const }
    manager['store'].saveTasks('shutdown', [task])
    const pending = manager.runTask(group, task, 'alice')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await manager.close()
    const result = await pending
    if (!manager.isClosed() || manager.getMember('alice')?.isBusy() || !result.includes('关闭')) throw new Error('TeamManager close 未取消成员执行')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('team 测试异常:', e)
  process.exit(1)
})
