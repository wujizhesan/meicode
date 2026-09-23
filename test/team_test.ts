// 团队系统测试：小组/邮箱锁/任务/成员/coordinator/协议
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { TeamManager, TeamGroupStore, TeamMail } from '../src/team/index.ts'
import { createLeadTools } from '../src/team/lead-tools.ts'
import { withLock } from '../src/team/lock.ts'
import { atomicWriteFile } from '../src/team/atomic.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { HookEngine } from '../src/hook/index.ts'

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

class DeferredTeamProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly started: Promise<void>
  private markStarted!: () => void
  private finishRun!: () => void
  private readonly gate: Promise<void>

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve })
    this.gate = new Promise((resolve) => { this.finishRun = resolve })
  }

  finish(): void {
    this.finishRun()
  }

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.markStarted()
    await this.gate
    yield { type: 'text', text: '延迟完成' }
    yield { type: 'done' }
  }
}

class ToolCallingTeamProvider implements Provider {
  readonly protocol = 'openai' as const
  private round = 0

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.round++
    if (this.round === 1) {
      yield { type: 'tool_call', id: 'member-read', name: 'read_file', arguments: { path: 'blocked.txt' } }
      yield { type: 'done' }
      return
    }
    yield { type: 'text', text: '成员完成' }
    yield { type: 'done' }
  }
}

const ctx: ToolContext = { cwd: REPO }

async function main() {
  // ---------- 小组持久化 ----------
  await check('小组: 创建与加载', () => {
    const store = new TeamGroupStore(TEAM_ROOT)
    const g = store.createGroup('dev', 'lead1')
    store.addMember(g, { name: 'alice', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' })
    const idempotent = store.createGroup('dev', 'lead1')
    if (idempotent.members.length !== 1 || idempotent.members[0]?.name !== 'alice') throw new Error('重复建组覆盖了已有成员')
    let leadConflictRejected = false
    try {
      store.createGroup('dev', 'lead2')
    } catch (error) {
      leadConflictRejected = (error as Error).message.includes('负责人为 lead1')
    }
    if (!leadConflictRejected) throw new Error('重复建组接受了不同负责人')
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
  await check('小组: 损坏任务文件拒绝读取和覆盖', async () => {
    const root = join(TMP, 'corrupt-tasks')
    const store = new TeamGroupStore(root)
    store.createGroup('broken', 'lead')
    const file = join(root, 'broken', 'tasks.json')
    const corrupted = '{"tasks":'
    writeFileSync(file, corrupted, 'utf8')
    let readRejected = false
    let mutationRejected = false
    try {
      store.listTasks('broken')
    } catch (error) {
      readRejected = (error as Error).message.includes('任务文件损坏')
    }
    try {
      store.updateTask('broken', 'missing', { status: 'done' })
    } catch (error) {
      mutationRejected = (error as Error).message.includes('任务文件损坏')
    }
    if (!readRejected || !mutationRejected || readFileSync(file, 'utf8') !== corrupted) throw new Error('损坏任务文件被静默接受或覆盖')
    const manager = new TeamManager(root, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    await manager.restore()
    if (readFileSync(file, 'utf8') !== corrupted) throw new Error('恢复流程覆盖了损坏任务文件')
    await manager.close()
  })
  await check('小组: 合法 JSON 的错误任务结构拒绝读取', () => {
    const root = join(TMP, 'invalid-task-shape')
    const store = new TeamGroupStore(root)
    store.createGroup('broken', 'lead')
    const file = join(root, 'broken', 'tasks.json')
    const invalid = JSON.stringify([null, { id: 'bad', title: 'bad', status: 'unknown' }])
    writeFileSync(file, invalid, 'utf8')
    let rejected = false
    try {
      store.listTasks('broken')
    } catch (error) {
      rejected = (error as Error).message.includes('第 1 项不是合法任务')
    }
    if (!rejected || readFileSync(file, 'utf8') !== invalid) throw new Error('错误任务结构被接受或覆盖')
  })
  await check('小组: 错误成员结构拒绝加载和覆盖', () => {
    const root = join(TMP, 'invalid-group-shape')
    const store = new TeamGroupStore(root)
    store.createGroup('broken', 'lead')
    const file = join(root, 'broken', 'group.yaml')
    const invalid = 'name: broken\nlead: lead\nmembers:\n  - name: worker\n    backend: invalid\n'
    writeFileSync(file, invalid, 'utf8')
    if (store.loadGroup('broken') !== null) throw new Error('错误成员结构被加载')
    let rejected = false
    try {
      store.createGroup('broken', 'lead')
    } catch (error) {
      rejected = (error as Error).message.includes('成员结构非法')
    }
    if (!rejected || readFileSync(file, 'utf8') !== invalid) throw new Error('错误成员结构被覆盖')
  })
  await check('持久化: 原子替换保留目标并清理临时文件', () => {
    const dir = join(TMP, 'atomic-write')
    const file = join(dir, 'state.json')
    mkdirSync(dir, { recursive: true })
    atomicWriteFile(file, 'old')
    atomicWriteFile(file, 'new')
    if (readFileSync(file, 'utf8') !== 'new') throw new Error('原子替换结果错误')
    if (readdirSync(dir).some((name) => name.endsWith('.tmp') || name.endsWith('.bak'))) throw new Error('原子替换残留临时文件')
    const directoryTarget = join(dir, 'directory-target')
    mkdirSync(directoryTarget)
    let rejected = false
    try {
      atomicWriteFile(directoryTarget, 'invalid')
    } catch {
      rejected = true
    }
    if (!rejected || !statSync(directoryTarget).isDirectory()) throw new Error('替换失败破坏了原目标')
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
  await check('邮箱: 跳过合法 JSON 的错误消息结构', () => {
    const dir = join(TEAM_ROOT, 'invalid-mail-shape')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'alice.mail')
    const valid = { messageId: 'valid', from: 'lead', to: 'alice', body: 'ok', ts: 1, read: false }
    writeFileSync(file, `null\n42\n{}\n${JSON.stringify(valid)}\n`, 'utf8')
    const mail = new TeamMail(dir)
    const messages = mail.read('alice', true)
    if (messages.length !== 1 || messages[0].messageId !== 'valid') throw new Error('错误消息结构未被跳过')
    const persisted = readFileSync(file, 'utf8')
    if (!persisted.includes('null\n42\n{}\n') || !mail.read('alice')[0]?.read) throw new Error('标记已读破坏了错误行或有效消息')
  })
  await check('邮箱: 大小写冲突与损坏注册表拒绝覆盖', () => {
    const caseDir = join(TMP, 'mail-case')
    const caseMail = new TeamMail(caseDir)
    caseMail.register('Alice')
    let caseRejected = false
    try {
      caseMail.register('alice')
    } catch (error) {
      caseRejected = (error as Error).message.includes('大小写冲突')
    }
    if (!caseRejected) throw new Error('大小写不同的邮箱名发生文件碰撞')

    const corruptDir = join(TMP, 'mail-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    const registryFile = join(corruptDir, 'registry.json')
    const corrupted = '{"Alice":'
    writeFileSync(registryFile, corrupted, 'utf8')
    let corruptRejected = false
    try {
      new TeamMail(corruptDir).register('bob')
    } catch (error) {
      corruptRejected = (error as Error).message.includes('邮箱注册表损坏')
    }
    const backup = readdirSync(corruptDir).find((name) => name.startsWith('registry.json.corrupt.'))
    if (!corruptRejected || existsSync(registryFile) || !backup || readFileSync(join(corruptDir, backup), 'utf8') !== corrupted) {
      throw new Error('损坏邮箱注册表被覆盖或未保留隔离副本')
    }
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
  await check('邮箱: 谓词异常不阻断发送和其他等待者', async () => {
    const mail = new TeamMail(join(TEAM_ROOT, 'predicate-error-mail'))
    mail.register('alice')
    const broken = mail.waitForMessage('alice', () => {
      throw new Error('predicate failed')
    }, 1000)
    const healthy = mail.waitForMessage('alice', (message) => message.body === 'wake', 1000)
    mail.send('lead', 'alice', 'wake')
    const [brokenResult, healthyResult] = await Promise.all([broken, healthy])
    if (brokenResult !== null || healthyResult?.body !== 'wake') throw new Error('谓词异常污染了消息发送或其他等待者')
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
    const ownershipLock = join(TMP, 'ownership.lock')
    withLock(ownershipLock, () => {
      writeFileSync(ownershipLock, JSON.stringify({ owner: 'replacement-owner', ts: Date.now() }), 'utf8')
    })
    if (!existsSync(ownershipLock)) throw new Error('旧锁持有者删除了新的 owner 锁')
    rmSync(ownershipLock, { force: true })
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
    const group = manager.createGroup('dev-tools', 'lead')
    await manager.spawnMember(group, 'alice', 'worker')
    // memberTools 按 ctx.cwd 解析身份——无 worktree 时成员 workdir = repoRoot
    const memberCtx = { ...ctx, cwd: REPO }
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
    const memberCtx = { ...ctx, cwd: REPO }
    const tools = manager.memberTools()
    const sendTool = tools.find((t) => t.name === 'team_send')!
    const r = await sendTool.execute({ to: 'bob', body: 'APPROVE 可以' }, memberCtx)
    if (!r.success) throw new Error('发送失败')
    const alias = await sendTool.execute({ to: 'Lead', body: 'IDLE 完成' }, memberCtx)
    if (!alias.success) throw new Error(`Lead 别名发送失败: ${alias.error}`)
    const mail = new TeamMail(join(TEAM_ROOT, '_shared', 'mail'))
    const msgs = mail.read('bob')
    if (!msgs.some((m) => m.from === 'alice')) throw new Error('消息未落盘')
    if (!mail.read('lead').some((m) => m.from === 'alice' && m.body === 'IDLE 完成')) throw new Error('Lead 别名未归一到小组邮箱')
  })

  // ---------- TeamManager ----------
  await check('TeamManager: 默认工作目录和角色加载绑定 repoRoot', async () => {
    const scopeRoot = join(TMP, 'team-repo-scope')
    const agentsDir = join(REPO, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'repo-scoped-role.md'), `---
name: repo-scoped-role
description: repo scoped role
tools_deny:
  - run_command
max_rounds: 7
---
repo scoped prompt
`, 'utf8')
    const manager = new TeamManager(scopeRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('scope', 'lead')
    const host = await manager.spawnMember(group, 'scoped', 'repo-scoped-role')
    if (group.members[0]?.workdir !== REPO) throw new Error('成员默认工作目录未使用 repoRoot')
    if (host['rolePrompt'] !== 'repo scoped prompt' || host['roleMaxRounds'] !== 7) throw new Error('派生成员未从 repoRoot 加载角色')
    await manager.close()

    const restored = new TeamManager(scopeRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    await restored.restore()
    const restoredHost = restored.getMember('scoped')
    if (restoredHost?.['rolePrompt'] !== 'repo scoped prompt' || restoredHost['roleMaxRounds'] !== 7) {
      throw new Error('恢复成员未从 repoRoot 加载角色')
    }
    await restored.close()
  })
  await check('TeamManager: 拒绝跨小组同名成员和关闭后派生', async () => {
    const ownershipRoot = join(TMP, 'team-member-ownership')
    const manager = new TeamManager(ownershipRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const firstGroup = manager.createGroup('first', 'lead')
    const secondGroup = manager.createGroup('second', 'lead')
    const firstHost = await manager.spawnMember(firstGroup, 'shared-name', 'worker')
    if (await manager.spawnMember(firstGroup, 'shared-name', 'worker') !== firstHost) throw new Error('同组成员幂等派生失效')
    let crossGroupRejected = false
    try {
      await manager.spawnMember(secondGroup, 'shared-name', 'worker')
    } catch (error) {
      crossGroupRejected = (error as Error).message.includes('已属于小组 first')
    }
    if (!crossGroupRejected || secondGroup.members.length !== 0) throw new Error('跨小组同名成员未被拒绝')
    let foreignTaskRejected = false
    try {
      manager.addTask(secondGroup.name, 'foreign assignment', 'shared-name')
    } catch (error) {
      foreignTaskRejected = (error as Error).message.includes('不属于小组 second')
    }
    if (!foreignTaskRejected || manager.listTasks(secondGroup.name).length !== 0) throw new Error('跨小组负责人任务未拒绝')
    if (!manager.respondApproval(secondGroup.name, 'shared-name', true).includes('不属于小组 second')) {
      throw new Error('跨小组审批未被拒绝')
    }
    await manager.close()
    let closedRejected = false
    try {
      await manager.spawnMember(firstGroup, 'after-close', 'worker')
    } catch (error) {
      closedRejected = (error as Error).message.includes('已关闭')
    }
    if (!closedRejected || manager.getMember('after-close')) throw new Error('关闭后仍可派生成员')
  })
  await check('TeamManager: 非法成员名在写入前拒绝', async () => {
    const validationRoot = join(TMP, 'team-member-validation')
    const manager = new TeamManager(validationRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('validation', 'lead')
    let rejected = false
    try {
      await manager.spawnMember(group, '../../escape', 'worker')
    } catch (error) {
      rejected = (error as Error).message.includes('成员名只能包含')
    }
    if (!rejected || group.members.length !== 0 || manager.getMember('../../escape')) throw new Error('非法成员名产生了部分状态')
    let reservedRejected = false
    try {
      await manager.spawnMember(group, 'Lead', 'worker')
    } catch (error) {
      reservedRejected = (error as Error).message.includes('不能与负责人')
    }
    if (!reservedRejected || group.members.length !== 0) throw new Error('负责人保留名称可被成员占用')
    await manager.close()
  })
  await check('TeamManager: 成员名大小写冲突在创建资源前拒绝', async () => {
    const validationRoot = join(TMP, 'team-member-case')
    const created: string[] = []
    const worktrees = {
      create: async (name: string) => {
        created.push(name)
        const path = join(TMP, name)
        mkdirSync(path, { recursive: true })
        return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
      },
      remove: async (name: string) => `已删除 worktree: ${name}`,
    }
    const manager = new TeamManager(validationRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    }, worktrees as never)
    const group = manager.createGroup('case-members', 'lead')
    await manager.spawnMember(group, 'Alice', 'worker')
    let rejected = false
    try {
      await manager.spawnMember(group, 'alice', 'worker')
    } catch (error) {
      rejected = (error as Error).message.includes('大小写冲突')
    }
    if (!rejected || created.includes('member-alice') || group.members.length !== 1) {
      throw new Error('大小写冲突成员在资源创建后才被拒绝')
    }
    const store = new TeamGroupStore(validationRoot)
    const snapshot = store.loadGroup(group.name)!
    let storeRejected = false
    try {
      store.addMember(snapshot, { name: 'alice', role: 'worker', workdir: REPO, backend: 'coroutine', needsApproval: false, status: 'idle' })
    } catch (error) {
      storeRejected = (error as Error).message.includes('大小写冲突')
    }
    if (!storeRejected || store.loadGroup(group.name)?.members.length !== 1) throw new Error('持久化层接受了大小写冲突成员')
    await manager.close()
  })
  await check('TeamManager: 派生前校验 agentId 并回滚失败 worktree', async () => {
    const validationRoot = join(TMP, 'team-spawn-transaction')
    const repo = join(TMP, 'team-spawn-transaction-repo')
    mkdirSync(repo, { recursive: true })
    const created: string[] = []
    const removed: string[] = []
    const worktrees = {
      create: async (name: string) => {
        created.push(name)
        const path = join(repo, name)
        mkdirSync(path, { recursive: true })
        return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
      },
      remove: async (name: string) => {
        removed.push(name)
        return `已删除 worktree: ${name}`
      },
    }
    const manager = new TeamManager(validationRoot, repo, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: repo },
    }, worktrees as never)
    const first = manager.createGroup('first', 'lead')
    const second = manager.createGroup('second', 'lead')
    await manager.spawnMember(first, 'alice', 'worker', { agentId: 'agent_shared' })
    let duplicateRejected = false
    try {
      await manager.spawnMember(second, 'bob', 'worker', { agentId: 'agent_shared' })
    } catch (error) {
      duplicateRejected = (error as Error).message.includes('已属于成员 alice')
    }
    if (!duplicateRejected || created.includes('member-bob')) throw new Error('重复 agentId 在创建 worktree 后才被拒绝')

    const rollbackGroup = manager.createGroup('rollback', 'lead')
    const rollbackFile = join(validationRoot, rollbackGroup.name, 'group.yaml')
    worktrees.create = async (name: string) => {
      created.push(name)
      rmSync(rollbackFile, { force: true })
      const path = join(repo, name)
      mkdirSync(path, { recursive: true })
      return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
    }
    let persistenceRejected = false
    try {
      await manager.spawnMember(rollbackGroup, 'carol', 'worker')
    } catch (error) {
      persistenceRejected = (error as Error).message.includes('不存在或文件损坏')
    }
    if (!persistenceRejected || !removed.includes('member-carol') || manager.getMember('carol')) {
      throw new Error('成员持久化失败后未回滚新 worktree 或仍注册 Host')
    }
    await manager.close()
  })
  await check('TeamManager: 成员状态更新不覆盖并发花名册', async () => {
    const stateRoot = join(TMP, 'team-member-state')
    const store = new TeamGroupStore(stateRoot)
    const initial = store.createGroup('state', 'lead')
    store.addMember(initial, {
      name: 'alice',
      agentId: 'agent_state_alice',
      role: 'worker',
      workdir: REPO,
      backend: 'coroutine',
      needsApproval: false,
      status: 'busy',
    })
    const manager = new TeamManager(stateRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    await manager.restore()
    const stale = manager.loadGroup('state')!
    const peer = new TeamGroupStore(stateRoot)
    const peerGroup = peer.loadGroup('state')!
    peer.addMember(peerGroup, {
      name: 'bob',
      agentId: 'agent_state_bob',
      role: 'worker',
      workdir: REPO,
      backend: 'coroutine',
      needsApproval: false,
      status: 'idle',
    })
    manager.markMemberIdle(stale, 'alice')
    const members = store.loadGroup('state')?.members ?? []
    if (!members.some((member) => member.name === 'bob') || members.find((member) => member.name === 'alice')?.status !== 'idle') {
      throw new Error('成员状态更新覆盖了并发新增成员')
    }
    await manager.close()
  })
  await check('TeamManager: 同目录成员按 agentId 识别身份', async () => {
    const identityRoot = join(TMP, 'team-member-identity')
    const manager = new TeamManager(identityRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('identity', 'lead')
    await manager.spawnMember(group, 'alpha', 'worker')
    await manager.spawnMember(group, 'beta', 'worker')
    const alpha = group.members.find((member) => member.name === 'alpha')
    const beta = group.members.find((member) => member.name === 'beta')
    if (!alpha?.agentId || !beta?.agentId || alpha.workdir !== beta.workdir) throw new Error('同目录成员测试准备失败')
    const tools = manager.memberTools()
    const taskTool = tools.find((tool) => tool.name === 'team_task')!
    const ambiguous = await taskTool.execute({ action: 'list' }, { cwd: REPO })
    if (ambiguous.success || !ambiguous.error?.includes('无法唯一识别')) throw new Error('共享 cwd 被错误解析为首个成员')
    const sendTool = tools.find((tool) => tool.name === 'team_send')!
    const sent = await sendTool.execute({ to: 'identity-target', body: 'from beta' }, { cwd: REPO, agentId: beta.agentId })
    if (!sent.success) throw new Error(`agentId 身份发送失败: ${sent.error}`)
    const unknown = await sendTool.execute({ to: 'lead', body: 'forged lead' }, { cwd: REPO, agentId: 'agent_unknown' })
    if (unknown.success || !unknown.error?.includes('无法识别消息发送者')) throw new Error('未知 agentId 被降级为 Lead 身份')
    const ambiguousSender = await sendTool.execute({ to: 'lead', body: 'ambiguous sender' }, { cwd: REPO })
    if (ambiguousSender.success) throw new Error('共享 cwd 的模糊身份被降级为 Lead')
    const messages = new TeamMail(join(identityRoot, '_shared', 'mail')).read('identity-target')
    if (!messages.some((message) => message.from === 'beta')) throw new Error('agentId 未解析到正确成员')
    if (new TeamMail(join(identityRoot, '_shared', 'mail')).read('lead').some((message) => message.body.includes('sender'))) {
      throw new Error('身份拒绝后仍写入了 Lead 邮箱')
    }
    await manager.close()
  })
  await check('MemberHost: Hook 使用稳定 agentId', async () => {
    const hookRoot = join(TMP, 'team-member-hook-id')
    const events: Array<{ event: string; agentId?: string }> = []
    const manager = new TeamManager(hookRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: {
        cwd: REPO,
        hooks: {
          fire: async (event: string, payload: { agentId?: string }) => {
            events.push({ event, agentId: payload.agentId })
          },
        } as never,
      },
    })
    const group = manager.createGroup('hook-id', 'lead')
    const host = await manager.spawnMember(group, 'alice', 'worker', { agentId: 'agent_hook_alice' })
    await host.execute('hook identity', 'task-hook-id')
    for (const event of ['subagent_start', 'subagent_stop', 'teammate_idle']) {
      if (!events.some((item) => item.event === event && item.agentId === 'agent_hook_alice')) {
        throw new Error(`${event} 未使用稳定 agentId`)
      }
    }
    await manager.close()
  })
  await check('MemberHost: 工具调用不会绕过 Hook 拦截', async () => {
    const hookRoot = join(TMP, 'team-member-hook-block')
    let executions = 0
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute() {
        executions++
        return { success: true, output: 'unexpected' }
      },
    })
    const hooks = new HookEngine([
      {
        event: 'tool_before',
        if: { all: [{ match: 'name', pattern: 'read_file' }] },
        action: { type: 'command', command: 'echo blocked' },
      },
    ])
    const manager = new TeamManager(hookRoot, REPO, {
      provider: new ToolCallingTeamProvider(),
      registry,
      ctx: { cwd: REPO, sessionId: 'member-hook-session', agentId: 'lead-agent', hooks },
    })
    const group = manager.createGroup('hook-block', 'lead')
    const host = await manager.spawnMember(group, 'alice', 'worker', { agentId: 'agent_hook_block' })
    const outcome = await host.execute('blocked tool', 'task-hook-block')
    if (executions !== 0 || outcome.status !== 'done') {
      throw new Error(`团队成员绕过 Hook: executions=${executions} status=${outcome.status}`)
    }
    if (!host.history.view().some((message) => message.role === 'tool' && message.content.includes('[Hook 拦截]'))) {
      throw new Error('团队成员历史未记录 Hook 拦截结果')
    }
    await manager.close()
  })
  await check('Lead 工具: 派发状态不误报完成', async () => {
    const leadRoot = join(TMP, 'team-lead-result')
    const manager = new TeamManager(leadRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('lead-result', 'lead')
    const assign = createLeadTools(manager).find((tool) => tool.name === 'team_assign')!
    const missing = await assign.execute({ group: group.name, task: 'missing member task', member: 'missing' }, ctx)
    if (missing.success || manager.listTasks(group.name).length !== 0) throw new Error('不存在成员仍创建了孤儿任务')
    const host = await manager.spawnMember(group, 'alice', 'worker')
    host['member'].status = 'busy'
    const queued = await assign.execute({ group: group.name, task: 'queued task', member: 'alice' }, ctx)
    if (!queued.success || !queued.output.includes('已进入队列') || queued.output.includes('已完成')) throw new Error('排队任务被误报为完成')
    host['member'].status = 'idle'
    const completed = await assign.execute({ group: group.name, task: 'completed task', member: 'alice' }, ctx)
    if (!completed.success || !completed.output.includes('已完成')) throw new Error('完成任务状态反馈错误')
    await manager.close()
  })
  await check('TeamManager: 合并拒绝运行中成员和未完成任务', async () => {
    const mergeRoot = join(TMP, 'team-merge-preflight')
    const manager = new TeamManager(mergeRoot, REPO, {
      provider: new FakeTeamProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx,
    })
    const group = manager.createGroup('merge-preflight', 'lead')
    const host = await manager.spawnMember(group, 'alice', 'worker')
    host['member'].status = 'busy'
    const busy = await manager.mergeAll(group)
    if (busy.success || !busy.output.includes('成员仍在执行任务')) throw new Error('运行中成员未阻止合并')
    host['member'].status = 'idle'
    manager.addTask(group.name, 'pending merge task', 'alice')
    const pending = await manager.mergeAll(group)
    if (pending.success || !pending.output.includes('仍有未完成任务')) throw new Error('未完成任务未阻止合并')
    const mergeTool = createLeadTools(manager).find((tool) => tool.name === 'team_merge')!
    const toolResult = await mergeTool.execute({ group: group.name }, ctx)
    if (toolResult.success || !toolResult.error?.includes('仍有未完成任务')) throw new Error('team_merge 拒绝结果仍被报告为成功')
    await manager.close()
  })
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
    if (!existsSync(join(REPO, '.meicode', 'artifacts'))) throw new Error('共享产物区未创建')
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
  await check('TeamManager: 关闭超时后在成员真正空闲时延迟释放 worktree', async () => {
    const provider = new DeferredTeamProvider()
    const released: string[] = []
    const worktreePath = join(REPO, 'deferred-member')
    const worktrees = {
      create: async (name: string) => {
        mkdirSync(worktreePath, { recursive: true })
        return { name, path: worktreePath, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
      },
      release: (name: string) => { released.push(name) },
      remove: async (name: string) => `已删除 worktree: ${name}`,
    }
    const sessionCtx: ToolContext = { cwd: REPO, sessionId: 'session-old' }
    const manager = new TeamManager(join(TMP, 'deferred-close-team'), REPO, {
      provider,
      registry: { toOpenAITools: () => [] } as never,
      ctx: sessionCtx,
    }, worktrees as never)
    const group = manager.createGroup('deferred-close', 'lead')
    const host = await manager.spawnMember(group, 'slow', 'worker')
    const task = manager.addTask(group.name, '忽略取消的慢任务', 'slow')
    await manager.assignTask(group, task, 'slow')
    await provider.started
    manager.setSessionId('session-new')
    if (host['ctx'].sessionId !== 'session-old') throw new Error('活动成员上下文被迁移到新会话')
    await manager.close(0)
    if (released.length !== 0) throw new Error('忙碌成员的 worktree 被提前释放')
    provider.finish()
    await host.whenIdle()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const releasesAfterIdle = [...released]
    if (releasesAfterIdle.length !== 1 || releasesAfterIdle[0] !== 'member-slow') throw new Error('成员空闲后未延迟释放 worktree')
    if (String(host['ctx'].sessionId) !== 'session-new') throw new Error('成员结束后未切换到新会话上下文')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('team 测试异常:', e)
  process.exit(1)
})
