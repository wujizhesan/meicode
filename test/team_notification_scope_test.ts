import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
import type { MailMessage, TeamTask } from '../src/team/types.ts'
import { atomicWriteFile } from '../src/team/atomic.ts'
import { streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: (root: string) => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_notification_scope_'))
  try { await test(root); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally {
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_notification_scope_'))
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
const notice = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  messageId: 'notice', groupId: 'audit', taskId: 'task', correlationId: 'report', from: 'alice', to: 'lead',
  body: 'RESULT', kind: 'task_result', ts: 1, read: false, ...overrides,
})
const task = (messages: MailMessage[], overrides: Partial<TeamTask> = {}): TeamTask => ({
  id: 'task', title: 'TASK', status: 'done', notifications: messages, ...overrides,
})
const invalid = [
  { name: '跨小组通知', tasks: [task([notice({ groupId: 'other' })])] },
  { name: '同一任务重复通知 ID', tasks: [task([notice(), notice({ body: 'OTHER', correlationId: 'other-report' })])] },
  { name: '跨任务同收件人重复通知 ID', tasks: [task([notice()]), task([notice({ taskId: 'other', body: 'OTHER' })], { id: 'other' })] },
  { name: '大小写别名收件人重复通知 ID', tasks: [task([notice(), notice({ to: 'Lead', body: 'OTHER' })])] },
  { name: '重复任务 ID', tasks: [task([notice()]), task([], { title: 'OTHER' })] },
]
for (const input of invalid) {
  for (const mode of ['fresh', 'written-cache']) {
    await check(`${input.name} ${mode} 拒绝读取和覆盖，原文件保留`, async (root) => {
      const store = new TeamGroupStore(root)
      store.createGroup('audit', 'lead')
      const file = join(root, 'audit', 'tasks.json')
      if (mode === 'fresh') fs.writeFileSync(file, JSON.stringify(input.tasks))
      else store.saveTasks('audit', input.tasks)
      const before = fs.readFileSync(file)
      assert.throws(() => store.listTasks('audit'), /任务文件损坏/)
      let mutated = false
      assert.throws(() => store.mutateTasks('audit', (tasks) => { mutated = true; tasks.length = 0 }), /任务文件损坏/)
      assert.equal(mutated, false)
      assert(fs.readFileSync(file).equals(before))
    })
  }
}
await check('当前缓存之后外部换入非法通知，不能覆盖新文件', async (root) => {
  const store = new TeamGroupStore(root)
  store.createGroup('audit', 'lead')
  store.saveTasks('audit', [task([notice()])])
  store.listTasks('audit')
  const file = join(root, 'audit', 'tasks.json')
  atomicWriteFile(file, JSON.stringify([task([notice({ groupId: 'other' })])]))
  const before = fs.readFileSync(file)
  assert.throws(() => store.updateTask('audit', 'task', { status: 'cancelled' }), /任务文件损坏/)
  assert(fs.readFileSync(file).equals(before))
})
await check('同 ID 不同收件人、不同报告历史通知和不同小组保持合法', async (root) => {
  const store = new TeamGroupStore(root)
  store.createGroup('audit', 'lead'); store.createGroup('other', 'lead')
  const messages = [notice(), notice({ to: 'observer' }), notice({ messageId: 'retry', kind: 'task_retry', correlationId: 'previous-report', ts: 0 })]
  store.saveTasks('audit', [task(messages, { reportId: 'current-report' })])
  store.saveTasks('other', [task([notice({ groupId: 'other', messageId: 'other-notice' })])])
  assert.equal(store.listTasks('audit')[0].notifications?.length, 3)
  assert.equal(new TeamGroupStore(root).listTasks('other')[0].notifications?.length, 1)
  store.listTasks('audit')[0].notifications![0].body = 'MUTATED'
  assert.equal(store.listTasks('audit')[0].notifications![0].body, 'RESULT')
})

for (const kind of ['foreign', 'duplicate']) {
  await check(`真实团队拒绝 ${kind} 通知，修复队列后仅发送一次`, async () => {
    let models = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
    const f = await streamFixture(provider), teamRoot = join(f.root, 'team')
    const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const store = new TeamGroupStore(teamRoot)
    try {
      team.createGroup('audit', 'lead')
      const bad = kind === 'foreign' ? [notice({ groupId: 'other' })] : [notice(), notice({ body: 'OTHER' })]
      store.saveTasks('audit', [task(bad)])
      const file = join(teamRoot, 'audit', 'tasks.json'), before = fs.readFileSync(file)
      assert.throws(() => team.listTasks('audit'), /任务文件损坏/)
      assert.equal(team.readLeadMail().length, 0)
      assert(fs.readFileSync(file).equals(before))
      store.saveTasks('audit', [task([notice()])])
      team.listTasks('audit'); team.listTasks('audit')
      assert.equal(team.readLeadMail().length, 1)
      assert.equal(store.listTasks('audit')[0].notifications, undefined)
      assert.equal(models, 0)
    } finally { await team.close(1000); await f.close() }
  })
}
await check('同 ID 不同收件人部分投递失败，未发送通知保留并自动恢复', async () => {
  let models = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
  const f = await streamFixture(provider), teamRoot = join(f.root, 'team')
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const store = new TeamGroupStore(teamRoot), mailRoot = join(teamRoot, '_shared', 'mail'), original = fs.appendFileSync
  let blocked = true
  try {
    team.createGroup('audit', 'lead')
    store.saveTasks('audit', [task([notice(), notice({ to: 'observer', body: 'OBSERVER' })])])
    fs.appendFileSync = ((file, data, options) => {
      if (blocked && String(file) === join(mailRoot, 'observer.mail')) throw Object.assign(new Error('OBSERVER-EIO'), { code: 'EIO' })
      return original(file, data, options)
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    team.listTasks('audit')
    assert.deepEqual(store.listTasks('audit')[0].notifications?.map((message) => message.to), ['observer'])
    assert.equal(team.readLeadMail().length, 1)
    assert.equal(new TeamMail(mailRoot).read('observer').length, 0)
    blocked = false
    const deadline = Date.now() + 2000
    while (store.listTasks('audit')[0].notifications && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    assert.equal(store.listTasks('audit')[0].notifications, undefined)
    assert.equal(new TeamMail(mailRoot).read('observer')[0]?.body, 'OBSERVER')
    assert.equal(team.readLeadMail().length, 1)
    assert.equal(models, 0)
  } finally { blocked = false; fs.appendFileSync = original; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})
await check('发送期间另一实例追加通知，自动补发无需再读取任务', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), teamRoot = join(f.root, 'team')
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const store = new TeamGroupStore(teamRoot), mailFile = join(teamRoot, '_shared', 'mail', 'lead.mail'), original = fs.appendFileSync
  let appended = false
  try {
    team.createGroup('audit', 'lead')
    store.saveTasks('audit', [task([notice()])])
    fs.appendFileSync = ((file, data, options) => {
      const result = original(file, data, options)
      if (String(file) === mailFile && !appended) {
        appended = true
        store.mutateTasks('audit', (tasks) => { tasks[0].notifications!.push(notice({ messageId: 'later', correlationId: 'later-report', body: 'LATER', ts: 2 })) })
      }
      return result
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    team.listTasks('audit')
    assert(appended)
    const deadline = Date.now() + 2000
    while (store.listTasks('audit')[0].notifications && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    assert.equal(store.listTasks('audit')[0].notifications, undefined)
    assert.deepEqual(team.readLeadMail().map((message) => message.body), ['RESULT', 'LATER'])
  } finally { fs.appendFileSync = original; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})
await check('发送期间另一实例变更收件人，旧确认不能清除新通知', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider), teamRoot = join(f.root, 'team')
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const store = new TeamGroupStore(teamRoot), mailRoot = join(teamRoot, '_shared', 'mail'), original = fs.appendFileSync
  let retargeted = false
  try {
    team.createGroup('audit', 'lead')
    store.saveTasks('audit', [task([notice()])])
    fs.appendFileSync = ((file, data, options) => {
      const result = original(file, data, options)
      if (String(file) === join(mailRoot, 'lead.mail') && !retargeted) {
        retargeted = true
        store.mutateTasks('audit', (tasks) => { tasks[0].notifications![0] = notice({ to: 'observer', body: 'RETARGETED' }) })
      }
      return result
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    team.listTasks('audit')
    assert(retargeted)
    assert.equal(store.listTasks('audit')[0].notifications?.[0].to, 'observer')
    const deadline = Date.now() + 2000
    while (store.listTasks('audit')[0].notifications && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    assert.equal(store.listTasks('audit')[0].notifications, undefined)
    assert.equal(new TeamMail(mailRoot).read('observer')[0]?.body, 'RETARGETED')
    assert.equal(team.readLeadMail().length, 1)
  } finally { fs.appendFileSync = original; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})
console.log(`通知范围与确认: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
