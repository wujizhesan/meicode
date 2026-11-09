import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
import { TeamTaskScheduler } from '../src/team/task-scheduler.ts'
import type { TeamTask, TeamTaskSettlement } from '../src/team/types.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: (root: string) => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_expiry_notification_'))
  try { await test(root); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally {
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_expiry_notification_'))
    const verify = (dir: string) => {
      assert(!fs.lstatSync(dir).isSymbolicLink())
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink())
        if (entry.isDirectory()) verify(join(dir, entry.name))
      }
    }
    verify(target)
    fs.rmSync(target, { recursive: true, force: true })
  }
}
const stale = (maxAttempts = 1, expiry = 10): TeamTask => ({
  id: 'task', title: 'STALE', assignee: 'alice', status: 'in_progress', attempt: 1, maxAttempts,
  activeAgentId: 'alice-agent', leaseId: 'old-lease', leaseExpiresAt: expiry,
  reportId: 'previous-report', report: { reportId: 'previous-report', status: 'failed', summary: 'OLD-FAILURE' },
  result: 'OLD-FAILURE',
})
function fixture(root: string, tasks: TeamTask[]) {
  const store = new TeamGroupStore(root), group = store.createGroup('audit', 'coordinator')
  store.saveTasks('audit', tasks)
  const mail = new TeamMail(join(root, '_shared', 'mail'))
  const scheduler = new TeamTaskScheduler({ store, mail, members: new Map(), memberGroups: new Map(), ctx: { cwd: root } })
  return { store, group, mail, scheduler }
}
for (const maxAttempts of [1, 2]) for (const expiry of [0, 10]) {
  await check(`过期时间 ${expiry} 上限 ${maxAttempts} 保存准确报告并只通知一次`, async (root) => {
    const f = fixture(root, [stale(maxAttempts, expiry)])
    try {
      const recovered = f.scheduler.recoverStaleTasks('audit', 20)
      assert.equal(recovered.length, 1)
      const saved = f.store.listTasks('audit')[0]
      assert.equal(saved.status, maxAttempts === 1 ? 'failed' : 'todo')
      assert.equal(saved.attempt, 1)
      assert.equal(saved.leaseId, undefined)
      assert.equal(saved.activeAgentId, undefined)
      assert.equal(saved.leaseExpiresAt, undefined)
      assert(saved.reportId && saved.reportId !== 'previous-report')
      assert.equal(saved.report?.reportId, saved.reportId)
      assert.equal(saved.report?.status, 'failed')
      assert.match(saved.result!, /租约过期/)
      assert.match(saved.report!.error!, /租约过期/)
      assert.equal(saved.nextRetryAt, maxAttempts === 1 ? undefined : 20)
      const messages = f.mail.read('coordinator')
      assert.equal(messages.length, 1)
      assert.equal(messages[0].correlationId, saved.reportId)
      assert.equal(messages[0].groupId, 'audit')
      assert.equal(messages[0].taskId, 'task')
      assert.equal(messages[0].kind, maxAttempts === 1 ? 'task_result' : 'task_retry')
      assert(messages[0].body.startsWith(maxAttempts === 1 ? 'ERR ' : 'RETRY '))
      recovered[0].report!.summary = 'MUTATED'
      assert.match(f.store.listTasks('audit')[0].report!.summary, /租约过期/)
      assert.deepEqual(f.scheduler.recoverStaleTasks('audit', 20), [])
      assert.equal(f.mail.read('coordinator').length, 1)
    } finally { await f.scheduler.close(0) }
  })
}
await check('未指定成员的旧版任务仍通知自定义负责人', async (root) => {
  const task = stale(); delete task.assignee; delete task.activeAgentId
  const f = fixture(root, [task])
  try {
    f.scheduler.recoverStaleTasks('audit', 20)
    assert.equal(f.mail.read('coordinator')[0]?.from, 'coordinator')
    assert.equal(f.mail.read('lead').length, 0)
  } finally { await f.scheduler.close(0) }
})
await check('过期恢复保留未发历史通知，新旧通知按顺序送达', async (root) => {
  const old = { messageId: 'old-notice', groupId: 'audit', taskId: 'task', correlationId: 'previous-report', from: 'alice', to: 'coordinator', body: 'PREVIOUS', kind: 'task_retry', ts: 1, read: false }
  const f = fixture(root, [{ ...stale(), notifications: [old] }])
  try {
    f.scheduler.recoverStaleTasks('audit', 20)
    const messages = f.mail.read('coordinator')
    assert.equal(messages.length, 2)
    assert.equal(messages[0].body, 'PREVIOUS')
    assert.equal(messages[1].kind, 'task_result')
    assert.equal(f.store.listTasks('audit')[0].notifications, undefined)
  } finally { await f.scheduler.close(0) }
})
for (const kind of ['result', 'cancel'] as const) {
  await check(`已持久化 ${kind} 补存优先于过期恢复，不生成虚假失败`, async (root) => {
    const f = fixture(root, [stale()])
    const entry: TeamTaskSettlement = { kind, groupName: 'audit', taskId: 'task', memberName: 'alice', leaseId: 'old-lease', agentId: 'alice-agent', reportId: 'real-report',
      ...(kind === 'result' ? { result: { status: 'done' as const, text: 'REAL-RESULT', report: { reportId: 'real-report', status: 'done' as const, summary: 'REAL-RESULT' } } } : {}),
    }
    try {
      f.store.saveTaskSettlement(entry)
      assert.deepEqual(f.scheduler.recoverStaleTasks('audit', 20), [])
      const saved = f.store.listTasks('audit')[0]
      assert.equal(saved.status, kind === 'result' ? 'done' : 'cancelled')
      assert.equal(saved.reportId, 'real-report')
      assert.equal(f.mail.read('coordinator').length, 1)
      assert(!f.mail.read('coordinator')[0].body.includes('租约过期'))
    } finally { await f.scheduler.close(0) }
  })
}
await check('未过期、无过期时间与已完成任务不生成恢复通知', async (root) => {
  const active = stale(1, 30), legacy = { ...stale(), id: 'legacy', leaseExpiresAt: undefined }, done = { ...stale(), id: 'done', status: 'done' as const }
  const f = fixture(root, [active, legacy, done])
  try {
    assert.deepEqual(f.scheduler.recoverStaleTasks('audit', 20), [])
    assert.equal(f.mail.read('coordinator').length, 0)
    assert.equal(f.store.listTasks('audit')[0].leaseId, 'old-lease')
  } finally { await f.scheduler.close(0) }
})
await check('恢复写盘失败保留原租约，不发送未保存的失败通知', async (root) => {
  const f = fixture(root, [stale()]), file = join(root, 'audit', 'tasks.json'), original = fs.renameSync
  const before = fs.readFileSync(file)
  fs.renameSync = ((source, destination) => {
    if (String(destination) === file && String(source).endsWith('.tmp')) throw Object.assign(new Error('EXPIRY-SAVE-EIO'), { code: 'EIO' })
    return original(source, destination)
  }) as typeof fs.renameSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => f.scheduler.recoverStaleTasks('audit', 20), /EXPIRY-SAVE-EIO/)
    assert(fs.readFileSync(file).equals(before))
    assert.equal(f.mail.read('coordinator').length, 0)
  } finally { fs.renameSync = original; syncBuiltinESMExports() }
  try {
    f.scheduler.recoverStaleTasks('audit', 20)
    assert.equal(f.mail.read('coordinator').length, 1)
    assert.equal(f.store.listTasks('audit')[0].status, 'failed')
  } finally { await f.scheduler.close(0) }
})
await check('恢复通知确认失败仍保留队列，恢复后无重复邮件', async (root) => {
  const f = fixture(root, [stale()]), file = join(root, 'audit', 'tasks.json'), original = fs.renameSync
  let blocked = true
  fs.renameSync = ((source, destination) => {
    if (blocked && String(destination) === file && String(source).endsWith('.tmp')) {
      const saved = JSON.parse(fs.readFileSync(source, 'utf8')) as TeamTask[]
      if (saved[0].status === 'failed' && !saved[0].notifications?.length) throw Object.assign(new Error('EXPIRY-ACK-EIO'), { code: 'EIO' })
    }
    return original(source, destination)
  }) as typeof fs.renameSync
  syncBuiltinESMExports()
  try {
    f.scheduler.recoverStaleTasks('audit', 20)
    assert.equal(f.store.listTasks('audit')[0].notifications?.length, 1)
    assert.equal(f.mail.read('coordinator').length, 1)
    blocked = false
    f.scheduler.listTasks('audit'); f.scheduler.listTasks('audit')
    assert.equal(f.store.listTasks('audit')[0].notifications, undefined)
    assert.equal(f.mail.read('coordinator').length, 1)
  } finally { blocked = false; fs.renameSync = original; syncBuiltinESMExports(); await f.scheduler.close(0) }
})
for (const maxAttempts of [1, 2]) {
  await check(`真实团队上限 ${maxAttempts} 恢复后通知重启补发，实际副作用不重复`, async () => {
    let models = 0, effects = 0, blocked = true
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'RECOVERED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider), teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options), original = fs.appendFileSync
    let fresh: TeamManager | undefined
    try {
      const group = team.createGroup('audit', 'coordinator')
      await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
      f.registry.register({ name: 'write_file', description: '验证恢复后真实写入一次', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(join(f.root, 'effect.log'), 'EFFECT\n'); return { success: true, output: 'SAVED' }
      } })
      store.saveTasks('audit', [stale(maxAttempts)])
      fs.appendFileSync = ((file, data, options) => {
        if (blocked && String(file).startsWith(join(teamRoot, '_shared', 'mail'))) throw Object.assign(new Error('EXPIRY-MAIL-EIO'), { code: 'EIO' })
        return original(file, data, options)
      }) as typeof fs.appendFileSync
      syncBuiltinESMExports()
      team.recoverStaleTasks('audit', 20)
      assert.equal(store.listTasks('audit')[0].notifications?.length, 1)
      await team.close(0)
      fresh = new TeamManager(teamRoot, f.root, options)
      await bounded(fresh.restore([]))
      if (maxAttempts === 2) {
        const deadline = Date.now() + 2500
        while (store.listTasks('audit')[0].status !== 'done' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
        assert.equal(store.listTasks('audit')[0].status, 'done')
      } else assert.equal(store.listTasks('audit')[0].status, 'failed')
      blocked = false
      fresh.listTasks('audit'); fresh.listTasks('audit')
      const messages = fresh.readLeadMail(false, 'audit')
      assert.equal(messages.length, maxAttempts)
      assert.equal(messages[0].kind, maxAttempts === 1 ? 'task_result' : 'task_retry')
      if (maxAttempts === 2) assert.equal(messages[1].kind, 'task_result')
      assert.equal(store.listTasks('audit')[0].notifications, undefined)
      assert.equal(models, maxAttempts === 1 ? 0 : 2)
      assert.equal(effects, maxAttempts === 1 ? 0 : 1)
      if (maxAttempts === 2) assert.equal(fs.readFileSync(join(f.root, 'effect.log'), 'utf8'), 'EFFECT\n')
    } finally { blocked = false; fs.appendFileSync = original; syncBuiltinESMExports(); await team.close(0); await fresh?.close(1000); await f.close() }
  })
}
await check('真实进程并发恢复同一租约，只生成一份报告与通知', async (root) => {
  const f = fixture(root, [stale()]), moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/team/task-scheduler.ts')).href
  const groupUrl = pathToFileURL(resolve(import.meta.dirname, '../src/team/group.ts')).href, mailUrl = pathToFileURL(resolve(import.meta.dirname, '../src/team/mail.ts')).href
  try {
    const source = `import { TeamTaskScheduler } from ${JSON.stringify(moduleUrl)}; import { TeamGroupStore } from ${JSON.stringify(groupUrl)}; import { TeamMail } from ${JSON.stringify(mailUrl)}; import { join } from 'node:path'; const root=${JSON.stringify(root)}; const scheduler=new TeamTaskScheduler({store:new TeamGroupStore(root),mail:new TeamMail(join(root,'_shared','mail')),members:new Map(),memberGroups:new Map(),ctx:{cwd:root}}); scheduler.recoverStaleTasks('audit',20); await scheduler.close(0);`
    const children = [1, 2].map(() => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''
      child.stderr.on('data', (data) => { error += String(data) })
      return new Promise<void>((done, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? done() : reject(new Error('恢复子进程失败: ' + error))) })
    })
    const results = await Promise.allSettled(children)
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const saved = f.store.listTasks('audit')[0], messages = f.mail.read('coordinator')
    assert.equal(saved.status, 'failed')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].correlationId, saved.reportId)
  } finally { await f.scheduler.close(0) }
})
for (const mode of ['missing', 'corrupt']) {
  await check(`负责人配置 ${mode} 时保留租约，修复后向正确负责人恢复通知`, async (root) => {
    const f = fixture(root, [stale()]), groupFile = join(root, 'audit', 'group.yaml')
    const groupBefore = fs.readFileSync(groupFile), taskBefore = fs.readFileSync(join(root, 'audit', 'tasks.json'))
    try {
      if (mode === 'missing') fs.unlinkSync(groupFile)
      else fs.writeFileSync(groupFile, 'name: [BROKEN')
      assert.throws(() => f.scheduler.recoverStaleTasks('audit', 20), /小组/)
      assert(fs.readFileSync(join(root, 'audit', 'tasks.json')).equals(taskBefore))
      assert.equal(f.mail.read('coordinator').length, 0)
      assert.equal(f.mail.read('lead').length, 0)
      fs.writeFileSync(groupFile, groupBefore)
      assert.equal(f.scheduler.recoverStaleTasks('audit', 20).length, 1)
      assert.equal(f.mail.read('coordinator').length, 1)
      assert.equal(f.mail.read('lead').length, 0)
    } finally { await f.scheduler.close(0) }
  })
}
console.log(`租约恢复通知: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
