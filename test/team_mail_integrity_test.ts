import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TeamMail } from '../src/team/mail.ts'

let passed = 0, failed = 0
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
async function check(name: string, test: (root: string) => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_mail_integrity_'))
  try { await test(root); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally {
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_mail_integrity_'))
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
const record = (id: string, to = 'alice', body = id) => ({ messageId: id, from: 'lead', to, body, ts: 1, read: false })
const write = (file: string, messages: unknown[]) => fs.writeFileSync(file, messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
const inspect = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

await check('广播已读只属于当前收件人，重启后仍独立', async (root) => {
  const mail = new TeamMail(root)
  mail.send('lead', '*', 'BROADCAST')
  mail.read('alice', true)
  assert.equal(mail.read('alice')[0].read, true)
  assert.equal(mail.read('bob')[0].read, false)
  const fresh = new TeamMail(root)
  assert.equal(fresh.readPage('alice', { unreadOnly: true }).messages.length, 0)
  assert.equal(fresh.readPage('bob', { unreadOnly: true }).messages.length, 1)
  fresh.read('bob', true)
  assert.equal(new TeamMail(root).read('alice')[0].read, true)
  assert.equal(new TeamMail(root).read('bob')[0].read, true)
  assert.equal(new TeamMail(root).read('carol')[0].read, false)
})

await check('广播分页只标记展示的邮件，其他人和下一页保持未读', async (root) => {
  const mail = new TeamMail(root)
  for (let index = 0; index < 3; index++) mail.send('lead', '*', 'B' + index, { ts: index })
  const first = mail.readPage('alice', { limit: 1, markRead: true })
  assert.equal(first.messages[0].body, 'B2')
  assert.equal(mail.readPage('alice', { unreadOnly: true }).unreadTotal, 2)
  assert.equal(mail.readPage('bob', { unreadOnly: true }).unreadTotal, 3)
  const second = new TeamMail(root).readPage('alice', { limit: 1, cursor: first.nextCursor, markRead: true })
  assert.equal(second.messages[0].body, 'B1')
  assert.equal(mail.readPage('alice', { unreadOnly: true }).messages[0].body, 'B0')
  assert.equal(mail.readPage('bob', { unreadOnly: true }).messages.length, 3)
})

await check('旧版重复广播按条标记当前收件人，不串其他人', async (root) => {
  const legacy = { from: 'lead', to: '*', body: 'SAME', ts: 1, read: false }
  write(join(root, 'broadcast.mail'), [legacy, legacy])
  const mail = new TeamMail(root)
  const first = mail.readPage('alice', { limit: 1, markRead: true })
  assert.equal(first.nextCursor, 'index:1')
  assert.deepEqual(mail.read('alice').map((message) => message.read), [false, true])
  assert.deepEqual(mail.read('bob').map((message) => message.read), [false, false])
})

await check('旧版已读广播保持兼容，调用方不能修改收件回执', async (root) => {
  write(join(root, 'broadcast.mail'), [{ ...record('legacy', '*'), read: true }, record('unread', '*')])
  const mail = new TeamMail(root)
  const messages = mail.read('alice')
  assert.deepEqual(messages.map((message) => message.read), [true, false])
  messages[1].read = true
  assert.equal(mail.read('alice')[1].read, false)
  mail.read('alice', true)
  assert(mail.read('alice').every((message) => !('readBy' in message)))
  assert.equal(mail.read('bob')[1].read, false)
})

await check('真实进程并发读取广播，各自回执均保存', async (root) => {
  new TeamMail(root).send('lead', '*', 'PROCESS-BROADCAST')
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/team/mail.ts')).href
  const children = ['alice', 'bob'].map((actor) => {
    const source = `import { TeamMail } from ${JSON.stringify(moduleUrl)}; const mail = new TeamMail(${JSON.stringify(root)}); mail.read(${JSON.stringify(actor)}, true);`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', (data) => { error += String(data) })
    return new Promise<void>((done, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => code === 0 ? done() : reject(new Error(`子进程 ${actor}: ${code} ${error}`)))
    })
  })
  const results = await Promise.allSettled(children)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  const fresh = new TeamMail(root)
  assert.equal(fresh.read('alice')[0].read, true)
  assert.equal(fresh.read('bob')[0].read, true)
  assert.equal(fresh.read('carol')[0].read, false)
})

await check('广播等待按当前收件人读取已读状态', async (root) => {
  const mail = new TeamMail(root)
  mail.send('lead', '*', 'WAIT-BROADCAST')
  mail.read('alice', true)
  const [alice, bob] = await Promise.all([
    mail.waitForMessage('alice', (message) => !message.read, 60),
    mail.waitForMessage('bob', (message) => !message.read, 60),
  ])
  assert.equal(alice, null)
  assert.equal(bob?.body, 'WAIT-BROADCAST')
})

for (const target of ['alice', '*']) {
  for (const partial of ['utf8', 'no-newline']) {
    await check(`标记 ${target} 已读保留 ${partial} 尾部原始字节`, async (root) => {
      const file = join(root, target === '*' ? 'broadcast.mail' : 'alice.mail')
      const first = Buffer.from(JSON.stringify(record('complete', target)) + '\n')
      const next = Buffer.from(JSON.stringify(record('pending', target, '等待中文字符')) + '\n')
      const split = partial === 'utf8' ? next.indexOf(Buffer.from('中')) + 1 : next.length - 1
      fs.writeFileSync(file, Buffer.concat([first, next.subarray(0, split)]))
      const mail = new TeamMail(root)
      assert.equal(mail.read('alice').length, 1)
      mail.read('alice', true)
      const after = fs.readFileSync(file)
      assert(after.subarray(-split).equals(next.subarray(0, split)))
      assert.equal(mail.read('alice').length, 1)
      fs.appendFileSync(file, next.subarray(split))
      assert.deepEqual(mail.read('alice').map((message) => message.messageId), ['complete', 'pending'])
      assert.deepEqual(mail.read('alice').map((message) => message.read), [true, false])
    })
  }
}

for (const tail of ['partial', 'no-newline']) {
  await check(`普通发送遇到 ${tail} 尾部不丢新邮件`, async (root) => {
    const file = join(root, 'alice.mail')
    const old = JSON.stringify(record('old'))
    fs.writeFileSync(file, tail === 'partial' ? old.slice(0, 35) : old)
    const mail = new TeamMail(root)
    mail.send('lead', 'alice', 'NEW')
    const messages = mail.read('alice')
    assert.equal(messages.filter((message) => message.body === 'NEW').length, 1)
    assert.equal(messages.some((message) => message.messageId === 'old'), tail === 'no-newline')
    assert(fs.readFileSync(file, 'utf8').startsWith(tail === 'partial' ? old.slice(0, 35) + '\n' : old + '\n'))
  })
}

for (const source of ['direct', 'broadcast']) {
  await check(`${source} 邮箱读取失败明确报错且不标记其他邮件`, async (root) => {
    const mail = new TeamMail(root)
    mail.send('lead', 'alice', 'DIRECT')
    mail.send('lead', '*', 'BROADCAST')
    mail.read('alice')
    const file = join(root, source === 'direct' ? 'alice.mail' : 'broadcast.mail')
    const original = fs.statSync
    fs.statSync = ((path, options) => {
      if (String(path) === file) throw Object.assign(new Error('MAIL-STAT-EIO'), { code: 'EIO' })
      return original(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports()
    try {
      assert.throws(() => mail.read('alice', true), /MAIL-STAT-EIO/)
      assert.throws(() => mail.readPage('alice', { markRead: true }), /MAIL-STAT-EIO/)
      assert.equal(inspect(join(root, 'alice.mail'))[0].read, false)
    } finally { fs.statSync = original; syncBuiltinESMExports() }
    assert.equal(mail.read('alice').length, 2)
  })
}

await check('发送前读取失败不追加，恢复后仅投递一次', async (root) => {
  const mail = new TeamMail(root)
  mail.send('lead', 'alice', 'FIRST')
  const file = join(root, 'alice.mail'), before = fs.readFileSync(file)
  const original = fs.statSync
  fs.statSync = ((path, options) => {
    if (String(path) === file) throw Object.assign(new Error('SEND-STAT-EIO'), { code: 'EIO' })
    return original(path, options)
  }) as typeof fs.statSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => mail.send('lead', 'alice', 'SECOND'), /SEND-STAT-EIO/)
    assert(fs.readFileSync(file).equals(before))
  } finally { fs.statSync = original; syncBuiltinESMExports() }
  mail.send('lead', 'alice', 'SECOND')
  assert.deepEqual(mail.read('alice').map((message) => message.body), ['FIRST', 'SECOND'])
})

for (const source of ['stat', 'read']) {
  await check(`初次等待 ${source} 读取失败，恢复后无需再次写入即可唤醒`, async (root) => {
    const file = join(root, 'alice.mail')
    write(file, [record('RECOVERED')])
    let blocked = true
    const originalStat = fs.statSync, originalRead = fs.readFileSync
    fs.statSync = ((path, options) => {
      if (blocked && source === 'stat' && String(path) === file) throw Object.assign(new Error('WAIT-STAT-EIO'), { code: 'EIO' })
      return originalStat(path, options)
    }) as typeof fs.statSync
    fs.readFileSync = ((path, options) => {
      if (blocked && source === 'read' && String(path) === file) throw Object.assign(new Error('WAIT-READ-EIO'), { code: 'EIO' })
      return originalRead(path, options)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    const controller = new AbortController(), mail = new TeamMail(root)
    try {
      const pending = mail.waitForMessage('alice', (message) => message.body === 'RECOVERED', 1200, controller.signal)
      pending.catch(() => {})
      await delay(80)
      blocked = false
      assert.equal((await pending)?.body, 'RECOVERED')
    } finally {
      blocked = false; controller.abort()
      fs.statSync = originalStat; fs.readFileSync = originalRead; syncBuiltinESMExports()
      assert.equal(mail['waiters'].size, 0)
      assert.equal(mail['watcher'], undefined)
      assert.equal(mail['pollTimer'], undefined)
    }
  })
}

await check('文件监听不可用时仍能收到外部写入且取消后清理', async (root) => {
  const original = fs.watch
  fs.watch = (() => { throw new Error('WATCH-UNAVAILABLE') }) as typeof fs.watch
  syncBuiltinESMExports()
  const controller = new AbortController(), mail = new TeamMail(root)
  try {
    const pending = mail.waitForMessage('alice', (message) => message.body === 'EXTERNAL', 1200, controller.signal)
    await delay(40)
    write(join(root, 'alice.mail'), [record('EXTERNAL')])
    assert.equal((await pending)?.body, 'EXTERNAL')
    const cancelled = mail.waitForMessage('alice', (message) => message.body === 'OTHER', 1200, controller.signal)
    controller.abort()
    assert.equal(await cancelled, null)
    assert.equal(mail['waiters'].size, 0)
    assert.equal(mail['watcher'], undefined)
    assert.equal(mail['pollTimer'], undefined)
  } finally { controller.abort(); fs.watch = original; syncBuiltinESMExports() }
})

await check('等待期间增量读取失败，恢复后不遗漏已经到达的邮件', async (root) => {
  const file = join(root, 'alice.mail')
  write(file, [record('SEED')])
  const mail = new TeamMail(root), controller = new AbortController()
  const pending = mail.waitForMessage('alice', (message) => message.body === 'NEW', 1500, controller.signal)
  const original = fs.readSync
  let blocked = true, failures = 0
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    if (blocked) { failures++; throw Object.assign(new Error('INCREMENTAL-READ-EIO'), { code: 'EIO' }) }
    return original(...args)
  }) as typeof fs.readSync
  syncBuiltinESMExports()
  try {
    fs.appendFileSync(file, JSON.stringify(record('NEW')) + '\n')
    const deadline = Date.now() + 800
    while (!failures && Date.now() < deadline) await delay(20)
    assert(failures > 0)
    blocked = false
    assert.equal((await pending)?.body, 'NEW')
  } finally {
    blocked = false; controller.abort(); await pending
    fs.readSync = original; syncBuiltinESMExports()
    assert.equal(mail['waiters'].size, 0)
    assert.equal(mail['pollTimer'], undefined)
  }
})

await check('读取持续失败时超时退出并释放监听和补查计时器', async (root) => {
  const original = fs.statSync, file = join(root, 'alice.mail')
  fs.statSync = ((path, options) => {
    if (String(path) === file) throw Object.assign(new Error('PERMANENT-EIO'), { code: 'EIO' })
    return original(path, options)
  }) as typeof fs.statSync
  syncBuiltinESMExports()
  const mail = new TeamMail(root)
  try {
    assert.equal(await mail.waitForMessage('alice', () => true, 60), null)
    assert.equal(mail['waiters'].size, 0)
    assert.equal(mail['watcher'], undefined)
    assert.equal(mail['pollTimer'], undefined)
  } finally { fs.statSync = original; syncBuiltinESMExports() }
})

await check('共享补查计时器在一个等待结束后仍服务其余收件人', async (root) => {
  const original = fs.watch
  fs.watch = (() => { throw new Error('WATCH-UNAVAILABLE') }) as typeof fs.watch
  syncBuiltinESMExports()
  const mail = new TeamMail(root), controller = new AbortController()
  try {
    const alice = mail.waitForMessage('alice', (message) => message.body === 'A', 1500, controller.signal)
    const bob = mail.waitForMessage('bob', (message) => message.body === 'B', 1500, controller.signal)
    const timer = mail['pollTimer']
    write(join(root, 'alice.mail'), [record('A')])
    assert.equal((await alice)?.body, 'A')
    assert.equal(mail['waiters'].size, 1)
    assert.equal(mail['pollTimer'], timer)
    write(join(root, 'bob.mail'), [record('B', 'bob')])
    assert.equal((await bob)?.body, 'B')
    assert.equal(mail['waiters'].size, 0)
    assert.equal(mail['pollTimer'], undefined)
  } finally { controller.abort(); fs.watch = original; syncBuiltinESMExports() }
})

console.log(`邮箱完整性: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
