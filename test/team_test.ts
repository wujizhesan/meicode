// 团队系统测试：小组/邮箱锁/任务/成员/coordinator/协议
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs'
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
    loaded.members[0].status = 'offline'
    if (store.loadGroup('dev')?.members[0].status === 'offline') throw new Error('小组缓存被调用方污染')
    if (!existsSync(join(TEAM_ROOT, 'dev', 'tasks.json'))) throw new Error('tasks.json 缺失')
    const listed = store.listGroups()
    listed.push('polluted')
    if (store.listGroups().includes('polluted')) throw new Error('团队列表缓存被调用方污染')
    new TeamGroupStore(TEAM_ROOT).createGroup('peer', 'lead2')
    if (!store.listGroups().includes('peer')) throw new Error('团队列表缓存未识别跨实例创建')
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
    tasks[0].status = 'failed'
    tasks[0].depends_on?.push('polluted')
    const cachedTasks = store.listTasks('dev')
    if (cachedTasks[0].status === 'failed' || cachedTasks[0].depends_on?.includes('polluted')) throw new Error('任务缓存被调用方污染')
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
    const batchSnapshot = store.loadGroup('dev')
    const peerSnapshot = store.loadGroup('dev')
    if (!batchSnapshot || !peerSnapshot) throw new Error('批量成员快照读取失败')
    staleB.addMember(peerSnapshot, { name: 'dave', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' })
    staleA.addMembers(batchSnapshot, [
      { name: 'bob', agentId: 'agent-bob-2', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' },
      { name: 'carol', agentId: 'agent-carol-2', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' },
    ])
    const membersAfterBatch = store.loadGroup('dev')?.members ?? []
    if (!membersAfterBatch.some((member) => member.name === 'dave') || membersAfterBatch.find((member) => member.name === 'bob')?.agentId !== 'agent-bob-2') {
      throw new Error('批量成员注册覆盖并发成员或未刷新成员')
    }
    const manager = new TeamManager(TEAM_ROOT, REPO, { provider: new FakeTeamProvider(), registry: { toOpenAITools: () => [] } as never, ctx })
    const appended = manager.addTask('dev', 'atomic append')
    if (!store.listTasks('dev').some((task) => task.id === appended.id)) throw new Error('任务原子追加失败')
    const tasksFile = join(TEAM_ROOT, 'dev', 'tasks.json')
    const tasksBefore = statSync(tasksFile)
    if (manager.recoverStaleTasks('dev', 20).length !== 0) throw new Error('错误恢复了未过期任务')
    const tasksAfter = statSync(tasksFile)
    if (tasksBefore.ino !== tasksAfter.ino || tasksBefore.mtimeMs !== tasksAfter.mtimeMs || tasksBefore.ctimeMs !== tasksAfter.ctimeMs) {
      throw new Error('无过期任务时仍然改写任务文件')
    }
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
    const registryFile = join(TEAM_ROOT, 'mail', 'registry.json')
    const registryBefore = statSync(registryFile)
    mail.register('alice')
    const registryAfter = statSync(registryFile)
    if (registryBefore.ino !== registryAfter.ino || registryBefore.mtimeMs !== registryAfter.mtimeMs || registryBefore.ctimeMs !== registryAfter.ctimeMs) {
      throw new Error('重复邮箱注册仍然改写注册表')
    }
    new TeamMail(join(TEAM_ROOT, 'mail')).register('carol')
    const externalBefore = statSync(registryFile)
    mail.register('carol')
    const externalAfter = statSync(registryFile)
    if (externalBefore.ino !== externalAfter.ino || externalBefore.mtimeMs !== externalAfter.mtimeMs || externalBefore.ctimeMs !== externalAfter.ctimeMs) {
      throw new Error('邮箱注册表缓存未识别跨实例修改')
    }
    mail.send('bob', 'alice', '第一条消息内容较长用于摘要截断验证')
    const msgs = mail.read('alice')
    if (msgs.length !== 1 || msgs[0].from !== 'bob') throw new Error('读取失败')
    msgs[0].body = '本地修改'
    if (mail.read('alice')[0].body === '本地修改') throw new Error('邮箱缓存泄露了调用方修改')
    mail.send('bob', 'alice', '第二条消息')
    if (mail.read('alice').length !== 2) throw new Error('邮箱缓存未识别追加消息')
    if (!msgs[0].ts || msgs[0].read !== false) throw new Error('时间戳/已读默认值缺失')
    if (!msgs[0].summary || msgs[0].summary.length > 80) throw new Error('摘要截断失败')
    mail.read('alice', true)
    if (!mail.read('alice')[0].read) throw new Error('已读标记失败')
    const settled = readFileSync(join(TEAM_ROOT, 'mail', 'alice.mail'), 'utf8')
    mail.read('alice', true)
    if (readFileSync(join(TEAM_ROOT, 'mail', 'alice.mail'), 'utf8') !== settled) throw new Error('重复已读改变了邮箱内容')
    mail.send('bob', 'alice', '已读后追加')
    const appended = mail.read('alice')
    if (appended.length !== 3 || appended[2].body !== '已读后追加' || appended[2].read) throw new Error('已读缓存未识别后续追加')
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
  await check('邮箱: 目录删除后自动重建', () => {
    const dir = join(TEAM_ROOT, 'recreated-mail')
    const mail = new TeamMail(dir)
    mail.send('lead', 'alice', 'before')
    rmSync(dir, { recursive: true, force: true })
    mail.send('lead', 'alice', 'after')
    const messages = mail.read('alice')
    if (messages.length !== 1 || messages[0].body !== 'after') throw new Error('邮箱目录未重建')
  })
  await check('邮箱: 增量解析跨中文字符边界', () => {
    const dir = join(TEAM_ROOT, 'incremental-mail')
    const file = join(dir, 'alice.mail')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '')
    const mail = new TeamMail(dir)
    mail.read('alice')
    const message = Buffer.from(JSON.stringify({
      messageId: 'split-utf8',
      from: 'lead',
      to: 'alice',
      body: '追加中文',
      ts: Date.now(),
      read: false,
      summary: '追加中文',
    }) + '\n')
    const marker = message.indexOf(Buffer.from('中'))
    if (marker < 0) throw new Error('测试数据缺少中文字符')
    const split = marker + 1
    appendFileSync(file, message.subarray(0, split))
    if (mail.read('alice').length !== 0) throw new Error('未完整的增量行被误解析')
    appendFileSync(file, message.subarray(split))
    appendFileSync(file, JSON.stringify({ messageId: 'backdated', from: 'lead', to: 'alice', body: '早到', ts: 1, read: false, summary: '早到' }) + '\n')
    appendFileSync(join(dir, 'broadcast.mail'), JSON.stringify({ messageId: 'broadcast-same-time', from: 'lead', to: '*', body: '广播', ts: 1, read: false, summary: '广播' }) + '\n')
    const messages = mail.read('alice')
    if (messages.length !== 3 || messages[2].messageId !== 'split-utf8') throw new Error('分段 UTF-8 增量行解析失败')
    if (messages[0].messageId !== 'backdated' || messages[1].messageId !== 'broadcast-same-time') throw new Error('增量邮件稳定排序失败')
  })
  await check('邮箱: 事件等待消息', async () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'wait-mail'))
    mail.register('alice')
    const pending = mail.waitForMessage('alice', (message) => message.body === 'wake', 1000)
    setTimeout(() => mail.send('lead', 'alice', 'wake'), 20)
    const message = await pending
    if (!message || message.body !== 'wake') throw new Error('邮件事件等待未唤醒')
  })
  await check('邮箱: 跨实例增量等待与谓词隔离', async () => {
    const dir = join(TEAM_ROOT, 'external-wait-mail')
    const receiver = new TeamMail(dir)
    const sender = new TeamMail(dir)
    receiver.register('alice')
    const pending = receiver.waitForMessage('alice', (message) => {
      if (message.body !== 'external-wake') return false
      message.body = 'local-mutation'
      return true
    }, 2000)
    setTimeout(() => sender.send('lead', 'alice', 'external-wake'), 20)
    const message = await pending
    if (!message || message.body !== 'local-mutation') throw new Error('跨实例文件监听未唤醒')
    if (receiver.read('alice')[0].body !== 'external-wake') throw new Error('等待谓词污染了邮箱缓存')
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
    const emptyStaleLock = join(TMP, 'empty-stale.lock')
    writeFileSync(emptyStaleLock, '')
    const staleTime = new Date(Date.now() - 60000)
    utimesSync(emptyStaleLock, staleTime, staleTime)
    let emptyStaleExecuted = false
    withLock(emptyStaleLock, () => {
      emptyStaleExecuted = true
    })
    if (!emptyStaleExecuted) throw new Error('空过期锁未按 mtime 覆盖')
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
