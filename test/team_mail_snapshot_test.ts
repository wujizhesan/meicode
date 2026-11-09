import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { TeamMail } from '../src/team/mail.ts'
import { atomicWriteFile } from '../src/team/atomic.ts'

let passed = 0, failed = 0
async function check(name: string, test: (root: string) => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_mail_snapshot_'))
  try { await test(root); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally {
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_mail_snapshot_'))
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
const record = (body: string, to = 'alice', ts = 1) => ({ messageId: body, from: 'lead', to, body, ts, read: false })
const bytes = (messages: unknown[]) => Buffer.from(messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
const filename = (root: string, to: string) => join(root, to === '*' ? 'broadcast.mail' : 'alice.mail')

for (const to of ['alice', '*']) {
  for (const state of ['fresh', 'cached']) {
    await check(`${to} ${state} 完整读取后同大小替换，不缓存旧内容`, async (root) => {
      const file = filename(root, to), old = bytes([record('OLD', to)]), next = bytes([record('NEW', to)])
      assert.equal(old.length, next.length)
      fs.writeFileSync(file, old)
      const mail = new TeamMail(root)
      if (state === 'cached') {
        assert.equal(mail.read('alice')[0].body, 'OLD')
        fs.utimesSync(file, new Date(), new Date(Date.now() + 1000))
      }
      const original = fs.readFileSync
      let replaced = false
      fs.readFileSync = ((path, options) => {
        const result = original(path, options)
        if (String(path) === file && !replaced) { replaced = true; atomicWriteFile(file, next) }
        return result
      }) as typeof fs.readFileSync
      syncBuiltinESMExports()
      try {
        assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW'])
        assert(replaced)
        assert.deepEqual(mail.readPage('alice').messages.map((message) => message.body), ['NEW'])
      } finally { fs.readFileSync = original; syncBuiltinESMExports() }
      assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW'])
    })
  }
}

for (const operation of ['append', 'truncate']) {
  await check(`完整读取期间 ${operation}，只返回一个稳定文件版本`, async (root) => {
    const file = filename(root, 'alice'), old = bytes([record('OLD')])
    fs.writeFileSync(file, old)
    const mail = new TeamMail(root), original = fs.readFileSync
    let changed = false
    fs.readFileSync = ((path, options) => {
      const result = original(path, options)
      if (String(path) === file && !changed) {
        changed = true
        if (operation === 'append') fs.appendFileSync(file, bytes([record('NEW', 'alice', 2)]))
        else fs.truncateSync(file, 0)
      }
      return result
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    try {
      assert.deepEqual(mail.read('alice').map((message) => message.body), operation === 'append' ? ['OLD', 'NEW'] : [])
    } finally { fs.readFileSync = original; syncBuiltinESMExports() }
  })
}

for (const to of ['alice', '*']) {
  for (const moment of ['before-open', 'after-read']) {
    await check(`${to} 增量读取 ${moment} 替换，不混合新旧文件正文`, async (root) => {
      const file = filename(root, to), padding = record('P'.repeat(100), to, 2), tail = record('TAIL', to, 3)
      fs.writeFileSync(file, bytes([record('OLD', to), padding]))
      const mail = new TeamMail(root)
      assert.deepEqual(mail.read('alice').map((message) => message.body), ['OLD', padding.body])
      fs.appendFileSync(file, bytes([tail]))
      const next = bytes([record('NEW', to), padding, tail]), originalOpen = fs.openSync, originalRead = fs.readSync
      let replaced = false
      const replace = () => { if (!replaced) { replaced = true; atomicWriteFile(file, next) } }
      fs.openSync = ((path, flags, mode) => {
        if (moment === 'before-open' && String(path) === file && flags === 'r') replace()
        return originalOpen(path, flags, mode)
      }) as typeof fs.openSync
      fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
        const count = originalRead(...args)
        if (moment === 'after-read' && count > 0) replace()
        return count
      }) as typeof fs.readSync
      syncBuiltinESMExports()
      try {
        assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW', padding.body, 'TAIL'])
        assert(replaced)
        assert.deepEqual(mail.readPage('alice').messages.map((message) => message.body), ['TAIL', padding.body, 'NEW'])
      } finally { fs.openSync = originalOpen; fs.readSync = originalRead; syncBuiltinESMExports() }
    })
  }
}

await check('读取后持续变化有界报错，稳定后可重新读取且不写入', async (root) => {
  const file = filename(root, 'alice')
  fs.writeFileSync(file, bytes([record('SEED')]))
  const mail = new TeamMail(root), original = fs.readFileSync
  let changes = 0
  fs.readFileSync = ((path, options) => {
    const result = original(path, options)
    if (String(path) === file) fs.appendFileSync(file, bytes([record('CHANGE-' + ++changes, 'alice', changes + 1)]))
    return result
  }) as typeof fs.readFileSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => mail.readPage('alice', { markRead: true }), /邮箱.*读取.*变化/)
    assert(changes > 1 && changes <= 8)
  } finally { fs.readFileSync = original; syncBuiltinESMExports() }
  const before = fs.readFileSync(file)
  assert.equal(mail.read('alice').length, changes + 1)
  assert(mail.read('alice').every((message) => !message.read))
  assert(fs.readFileSync(file).equals(before))
})

await check('消息等待遇到同大小替换，最后一次写入后仍能唤醒并清理', async (root) => {
  const file = filename(root, 'alice')
  fs.writeFileSync(file, bytes([record('OLD')]))
  const mail = new TeamMail(root), original = fs.readFileSync, controller = new AbortController()
  let replaced = false
  fs.readFileSync = ((path, options) => {
    const result = original(path, options)
    if (String(path) === file && !replaced) { replaced = true; atomicWriteFile(file, bytes([record('NEW')])) }
    return result
  }) as typeof fs.readFileSync
  syncBuiltinESMExports()
  try {
    assert.equal((await mail.waitForMessage('alice', (message) => message.body === 'NEW', 1000, controller.signal))?.body, 'NEW')
    assert.equal(mail['waiters'].size, 0)
    assert.equal(mail['watcher'], undefined)
    assert.equal(mail['pollTimer'], undefined)
  } finally { controller.abort(); fs.readFileSync = original; syncBuiltinESMExports() }
})

await check('真实子进程在完整读取和 stat 之间替换，旧内容不能覆盖缓存', async (root) => {
  const file = filename(root, 'alice'), next = bytes([record('NEW')])
  fs.writeFileSync(file, bytes([record('OLD')]))
  const mail = new TeamMail(root), original = fs.readFileSync
  let replaced = false
  fs.readFileSync = ((path, options) => {
    const result = original(path, options)
    if (String(path) === file && !replaced) {
      replaced = true
      const child = spawnSync(process.execPath, ['-e', "const fs=require('node:fs'); fs.writeFileSync(process.argv[1]+'.swap',process.argv[2]); fs.renameSync(process.argv[1]+'.swap',process.argv[1]);", file, next.toString('utf8')], { windowsHide: true, timeout: 3000, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr || String(child.error ?? '子进程替换失败'))
    }
    return result
  }) as typeof fs.readFileSync
  syncBuiltinESMExports()
  try {
    assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW'])
    assert(replaced)
    assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW'])
  } finally { fs.readFileSync = original; syncBuiltinESMExports() }
})

await check('文件稳定时继续命中缓存和增量读取，不退化为反复全量读取', async (root) => {
  const file = filename(root, 'alice')
  fs.writeFileSync(file, bytes([record('OLD')]))
  const mail = new TeamMail(root), original = fs.readFileSync
  let reads = 0
  fs.readFileSync = ((path, options) => {
    if (String(path) === file) reads++
    return original(path, options)
  }) as typeof fs.readFileSync
  syncBuiltinESMExports()
  try {
    for (let index = 0; index < 20; index++) assert.equal(mail.read('alice')[0].body, 'OLD')
    assert.equal(reads, 1)
    fs.appendFileSync(file, bytes([record('NEW', 'alice', 2)]))
    assert.deepEqual(mail.read('alice').map((message) => message.body), ['OLD', 'NEW'])
    assert.equal(reads, 1)
  } finally { fs.readFileSync = original; syncBuiltinESMExports() }
})

await check('读取后 stat 故障明确失败，恢复后按新文件读取', async (root) => {
  const file = filename(root, 'alice')
  fs.writeFileSync(file, bytes([record('OLD')]))
  const mail = new TeamMail(root), originalRead = fs.readFileSync, originalStat = fs.statSync
  let read = false
  fs.readFileSync = ((path, options) => {
    const result = originalRead(path, options)
    if (String(path) === file) { read = true; atomicWriteFile(file, bytes([record('NEW')])) }
    return result
  }) as typeof fs.readFileSync
  fs.statSync = ((path, options) => {
    if (String(path) === file && read) throw Object.assign(new Error('SNAPSHOT-STAT-EIO'), { code: 'EIO' })
    return originalStat(path, options)
  }) as typeof fs.statSync
  syncBuiltinESMExports()
  try { assert.throws(() => mail.read('alice', true), /SNAPSHOT-STAT-EIO/) }
  finally { fs.readFileSync = originalRead; fs.statSync = originalStat; syncBuiltinESMExports() }
  assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW'])
  assert.equal(mail.read('alice')[0].read, false)
})

await check('重试完整读取仍保留半个 UTF-8 尾部，补齐后只出现一次', async (root) => {
  const file = filename(root, 'alice'), pending = bytes([record('中文等待', 'alice', 2)])
  const split = pending.indexOf(Buffer.from('中')) + 1
  fs.writeFileSync(file, bytes([record('OLD')]))
  const mail = new TeamMail(root), original = fs.readFileSync
  let replaced = false
  fs.readFileSync = ((path, options) => {
    const result = original(path, options)
    if (String(path) === file && !replaced) {
      replaced = true
      atomicWriteFile(file, Buffer.concat([bytes([record('NEW')]), pending.subarray(0, split)]))
    }
    return result
  }) as typeof fs.readFileSync
  syncBuiltinESMExports()
  try { assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW']) }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  fs.appendFileSync(file, pending.subarray(split))
  assert.deepEqual(mail.read('alice').map((message) => message.body), ['NEW', '中文等待'])
})

console.log(`邮箱读取快照: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
