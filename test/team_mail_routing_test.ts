import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: (root: string) => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_mail_routing_'))
  try { await test(root); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally {
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_mail_routing_'))
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
const message = (body: string, overrides = {}) => ({ messageId: 'duplicate', from: 'alice', to: 'lead', body, ts: 1, read: false, ...overrides })
const writeMessages = (file: string, messages: unknown[]) => fs.writeFileSync(file, messages.map((item) => JSON.stringify(item)).join('\n') + '\n')
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2500
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('邮箱路由回归超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}

for (const actor of ['broadcast', 'Broadcast']) {
  await check(`${actor} 成员收取私信和公共广播各一次`, async (root) => {
    const mail = new TeamMail(root)
    mail.register(actor)
    mail.send('lead', actor, 'PRIVATE')
    mail.send('lead', '*', 'PUBLIC')
    assert.deepEqual(mail.read(actor).map((item) => item.body), ['PRIVATE', 'PUBLIC'])
    assert.equal(mail.readPage(actor).total, 2)
    assert.deepEqual(new TeamMail(root).read(actor).map((item) => item.body), ['PRIVATE', 'PUBLIC'])
  })

  await check(`发往 ${actor} 的私信不会通过公共广播进入其他邮箱`, async (root) => {
    const mail = new TeamMail(root)
    mail.send('lead', actor, 'LEAD-PRIVATE')
    mail.send('alice', actor, 'ALICE-PRIVATE')
    mail.send('observer', '*', 'PUBLIC')
    for (const reader of ['lead', 'alice', 'bob']) {
      assert.deepEqual(mail.read(reader).map((item) => item.body), ['PUBLIC'])
      assert.equal(mail.readPage(reader, { unreadOnly: true }).unreadTotal, 1)
    }
  })
}

await check('共用物理文件的私信和广播使用同一 ID 时仍分别投递', async (root) => {
  const mail = new TeamMail(root)
  mail.send('lead', 'broadcast', 'PRIVATE', { messageId: 'shared', ts: 1 })
  mail.send('lead', '*', 'PUBLIC', { messageId: 'shared', ts: 2 })
  assert.deepEqual(mail.read('broadcast').map((item) => item.body), ['PRIVATE', 'PUBLIC'])
  assert.deepEqual(mail.read('bob').map((item) => item.body), ['PUBLIC'])
  mail.send('lead', 'broadcast', 'PRIVATE', { messageId: 'shared', ts: 1 })
  mail.send('lead', '*', 'PUBLIC', { messageId: 'shared', ts: 2 })
  assert.equal(mail.read('broadcast').length, 2)
})

await check('共享 ID 的私信和广播，已读只标记当前页对应的收件人', async (root) => {
  writeMessages(join(root, 'broadcast.mail'), [message('PRIVATE', { to: 'broadcast' }), message('PUBLIC', { to: '*', ts: 2 })])
  const mail = new TeamMail(root)
  const first = mail.readPage('broadcast', { limit: 1, markRead: true })
  assert.equal(first.messages[0].body, 'PUBLIC')
  assert.deepEqual(mail.read('broadcast').map((item) => item.read), [false, true])
  assert.equal(mail.read('bob')[0].read, false)
  const second = mail.readPage('broadcast', { limit: 1, cursor: first.nextCursor, markRead: true })
  assert.equal(second.messages[0].body, 'PRIVATE')
  assert.deepEqual(mail.read('broadcast').map((item) => item.read), [true, true])
  assert.equal(mail.read('bob')[0].read, false)
})

await check('消息等待不通过公共文件接收其他人的私信', async (root) => {
  const mail = new TeamMail(root), controller = new AbortController()
  const owner = mail.waitForMessage('broadcast', (item) => item.body === 'PRIVATE', 500, controller.signal)
  const other = mail.waitForMessage('lead', (item) => item.body === 'PRIVATE', 350, controller.signal)
  try {
    mail.send('lead', 'broadcast', 'PRIVATE')
    assert.equal((await owner)?.body, 'PRIVATE')
    assert.equal(await other, null)
    assert.equal(mail['waiters'].size, 0)
  } finally { controller.abort(); await Promise.allSettled([owner, other]) }
})

await check('旧版混合邮箱不重复读取、不泄露私信，读取不改写文件', async (root) => {
  const file = join(root, 'broadcast.mail')
  writeMessages(file, [message('OLD-PRIVATE', { to: 'broadcast', messageId: 'private' }), message('OLD-PUBLIC', { to: '*', messageId: 'public', ts: 2 })])
  const before = fs.readFileSync(file), mail = new TeamMail(root)
  assert.deepEqual(mail.read('broadcast').map((item) => item.body), ['OLD-PRIVATE', 'OLD-PUBLIC'])
  assert.deepEqual(mail.read('alice').map((item) => item.body), ['OLD-PUBLIC'])
  assert(fs.readFileSync(file).equals(before))
})

await check('点对点和广播同 ID 时分页不遗漏较早私信', async (root) => {
  const mail = new TeamMail(root)
  mail.send('alice', 'lead', 'OLDEST', { messageId: 'oldest', ts: 0 })
  mail.send('alice', 'lead', 'PRIVATE', { messageId: 'shared', ts: 1 })
  mail.send('alice', '*', 'PUBLIC', { messageId: 'shared', ts: 2 })
  const first = mail.readPage('lead', { limit: 1 })
  assert.equal(first.messages[0].body, 'PUBLIC')
  const second = mail.readPage('lead', { cursor: first.nextCursor, limit: 3, markRead: true })
  assert.deepEqual(second.messages.map((item) => item.body), ['PRIVATE', 'OLDEST'])
  assert.equal(second.nextCursor, undefined)
  assert.equal(mail.read('lead').find((item) => item.body === 'PUBLIC')!.read, false)
})

await check('旧版完全重复 ID 的分页按原记录定位，后来追加不改变锚点', async (root) => {
  const file = join(root, 'lead.mail')
  writeMessages(file, ['A', 'B', 'C'].map((body) => message(body)))
  const mail = new TeamMail(root), first = mail.readPage('lead', { limit: 1, markRead: true })
  assert.equal(first.messages[0].body, 'C')
  fs.appendFileSync(file, JSON.stringify(message('D')) + '\n')
  const second = mail.readPage('lead', { limit: 1, cursor: first.nextCursor, markRead: true })
  assert.equal(second.messages[0].body, 'B')
  const third = mail.readPage('lead', { limit: 1, cursor: second.nextCursor })
  assert.equal(third.messages[0].body, 'A')
  assert.equal(third.nextCursor, undefined)
  assert.equal(mail.read('lead').find((item) => item.body === 'D')!.read, false)
})

await check('新分页游标绑定当前邮箱，跨收件人复用不能标记邮件', async (root) => {
  const mail = new TeamMail(root)
  mail.send('alice', 'lead', 'OLDER', { ts: 1 })
  mail.send('alice', '*', 'PUBLIC', { ts: 2 })
  const first = mail.readPage('lead', { limit: 1 })
  assert(first.nextCursor)
  const before = fs.readFileSync(join(root, 'broadcast.mail'))
  assert.throws(() => mail.readPage('bob', { cursor: first.nextCursor, markRead: true }), /游标无效或已过期/)
  assert(fs.readFileSync(join(root, 'broadcast.mail')).equals(before))
})

await check('旧版唯一 ID 和无 ID 的索引游标保持可读', async (root) => {
  const file = join(root, 'lead.mail'), mail = new TeamMail(root)
  writeMessages(file, [message('A', { messageId: 'a' }), message('B', { messageId: 'b', ts: 2 })])
  assert.deepEqual(mail.readPage('lead', { cursor: 'id:b' }).messages.map((item) => item.body), ['A'])
  assert.deepEqual(mail.readPage('lead', { cursor: 'index:1' }).messages.map((item) => item.body), ['A'])
})

await check('旧版歧义 ID 游标拒绝定位且不修改未读', async (root) => {
  const file = join(root, 'lead.mail')
  writeMessages(file, [message('A'), message('B')])
  const before = fs.readFileSync(file)
  assert.throws(() => new TeamMail(root).readPage('lead', { cursor: 'id:duplicate', markRead: true }), /游标无效或已过期/)
  assert(fs.readFileSync(file).equals(before))
})

await check('错误的新游标字段拒绝读取且不写入', async (root) => {
  const file = join(root, 'lead.mail')
  writeMessages(file, [message('A'), message('B')])
  const mail = new TeamMail(root), before = fs.readFileSync(file)
  const values = [null, [], ['lead', 'duplicate', 'alice', 'lead', 1, -1], ['lead', 'duplicate', 'alice', 'lead', 1, 1.5], ['lead', 'duplicate', 'alice', 'lead', 1, 99], ['bob', 'duplicate', 'alice', 'lead', 1, 1]]
  for (const value of values) {
    const cursor = 'mail:' + Buffer.from(JSON.stringify(value)).toString('base64url')
    assert.throws(() => mail.readPage('lead', { cursor, markRead: true }), /游标无效或已过期/)
  }
  assert(fs.readFileSync(file).equals(before))
})

await check('真实进程并发投递同 ID 到共享文件，两个收件范围均保留', async (root) => {
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/team/mail.ts')).href
  const children = ['broadcast', '*'].map((to) => {
    const source = `import { TeamMail } from ${JSON.stringify(moduleUrl)}; new TeamMail(${JSON.stringify(root)}).send('lead', ${JSON.stringify(to)}, ${JSON.stringify(to === '*' ? 'PUBLIC' : 'PRIVATE')}, { messageId: 'shared', ts: ${to === '*' ? 2 : 1} });`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', (data) => { error += String(data) })
    return new Promise<void>((done, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => code === 0 ? done() : reject(new Error(`子进程 ${to}: ${code} ${error}`)))
    })
  })
  const results = await Promise.allSettled(children)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  const mail = new TeamMail(root)
  assert.deepEqual(mail.read('broadcast').map((item) => item.body), ['PRIVATE', 'PUBLIC'])
  assert.deepEqual(mail.read('lead').map((item) => item.body), ['PUBLIC'])
})

for (const role of ['member', 'lead']) {
  await check(`真实 ${role} 名为 broadcast 时审批只看到一份 PLAN 并执行一次`, async () => {
    let models = 0, effects = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'ROUTING-APPROVED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider), teamRoot = join(f.root, 'team')
    const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: { ...f.chat.getToolContext(), agentId: 'lead-agent' } })
    const member = role === 'member' ? 'broadcast' : 'alice', lead = role === 'lead' ? 'broadcast' : 'lead'
    const mail = new TeamMail(join(teamRoot, '_shared', 'mail'))
    let execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', lead)
      await team.spawnMember(group, member, 'worker', { agentId: 'member-agent', needsApproval: true, roleDefinition: null })
      mail.send('observer', '*', 'PUBLIC')
      f.registry.register({ name: 'write_file', description: '回归审批后真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(join(f.root, 'effect.log'), 'EFFECT\n'); return { success: true, output: 'SAVED' }
      } })
      const task = team.addTask('audit', 'ROUTING-APPROVAL', member)
      execution = team.runTask(group, task, member)
      await waitUntil(() => team.readLeadMail(false, 'audit').some((item) => item.kind === 'approval_plan'))
      assert.equal(team.readLeadMail(false, 'audit').filter((item) => item.kind === 'approval_plan').length, 1)
      assert.equal(mail.read(member).filter((item) => item.body === 'PUBLIC').length, 1)
      assert.equal(mail.read(member).filter((item) => item.kind === 'approval_plan').length, 0)
      assert.equal(models, 0)
      assert(!team.respondApproval('audit', member, true).startsWith('审批失败:'))
      await bounded(execution)
      assert.equal(team.listTasks('audit')[0].status, 'done')
      assert.equal(models, 2)
      assert.equal(effects, 1)
      assert.equal(fs.readFileSync(join(f.root, 'effect.log'), 'utf8'), 'EFFECT\n')
    } finally { await team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}

console.log(`邮箱路由与分页: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
