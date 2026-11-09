import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { SubAgentStore } from '../src/subagent/store.ts'
import type { SubAgentRecord } from '../src/subagent/types.ts'

let passed = 0, failed = 0
const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_subagent_read_'))
const original = { readFileSync: fs.readFileSync, statSync: fs.statSync, renameSync: fs.renameSync }
const restore = () => { Object.assign(fs, original); syncBuiltinESMExports() }
function check(name: string, test: () => void) {
  try { test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally { restore() }
}
const record = (id: string): SubAgentRecord => ({ id, role: 'worker', type: 'fork', status: 'done', startedAt: 1 })
function readFault(file: string, stage: 'read' | 'stat', code: string) {
  const fail = () => { throw Object.assign(new Error('TRANSIENT-' + code), { code }) }
  if (stage === 'read') fs.readFileSync = ((path: unknown, ...args: unknown[]) => String(path) === file ? fail()
    : (original.readFileSync as (...params: unknown[]) => unknown)(path, ...args)) as typeof fs.readFileSync
  else fs.statSync = ((path: unknown, ...args: unknown[]) => String(path) === file ? fail()
    : (original.statSync as (...params: unknown[]) => unknown)(path, ...args)) as typeof fs.statSync
  syncBuiltinESMExports()
}

try {
  for (const stage of ['read', 'stat'] as const) for (const code of ['EACCES', 'EIO']) for (const action of ['load', 'save']) {
    check(stage + ' ' + code + ' 时 ' + action + ' 保留原文件，不误隔离或覆盖，恢复后可重试', () => {
      const dir = join(root, stage + '-' + code + '-' + action), file = join(dir, 'state.json')
      const writer = new SubAgentStore(dir, 'state')
      writer.save(record('old-a')); writer.save(record('old-b'))
      const before = fs.readFileSync(file, 'utf8'), store = new SubAgentStore(dir, 'state')
      readFault(file, stage, code)
      assert.throws(() => action === 'load' ? store.load() : store.save(record('next')), new RegExp('TRANSIENT-' + code))
      restore()
      assert.equal(fs.readFileSync(file, 'utf8'), before)
      assert(!fs.readdirSync(dir).some((name) => name.includes('.corrupt.')))
      assert.deepEqual(store.load().map((item) => item.id), ['old-a', 'old-b'])
      store.save(record('next'))
      assert.deepEqual(new SubAgentStore(dir, 'state').load().map((item) => item.id), ['old-a', 'old-b', 'next'])
    })
  }

  check('租约续期读取失败不清空任务，恢复后 owner 仍可续期', () => {
    const dir = join(root, 'lease'), file = join(dir, 'state.json'), writer = new SubAgentStore(dir, 'state')
    const active: SubAgentRecord = { ...record('active'), status: 'running', ownerId: 'owner', leaseExpiresAt: 60000 }
    writer.save(active); writer.save(record('sibling'))
    const store = new SubAgentStore(dir, 'state'), before = fs.readFileSync(file, 'utf8')
    readFault(file, 'read', 'EIO')
    assert.throws(() => store.renewLease('active', 'owner', 120000), /TRANSIENT-EIO/)
    restore()
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(store.renewLease('active', 'owner', 120000)?.leaseExpiresAt, 120000)
    assert.equal(store.get('sibling')?.status, 'done')
  })

  for (const raw of ['{broken', '[null]']) check('真正损坏的内容仍隔离并保留原始字节 ' + raw, () => {
    const dir = join(root, raw === '{broken' ? 'syntax' : 'structure'), file = join(dir, 'state.json')
    fs.mkdirSync(dir)
    fs.writeFileSync(file, raw)
    const store = new SubAgentStore(dir, 'state')
    assert.deepEqual(store.load(), [])
    const backup = fs.readdirSync(dir).find((name) => name.startsWith('state.json.corrupt.'))!
    assert(backup)
    assert.equal(fs.readFileSync(join(dir, backup), 'utf8'), raw)
    store.save(record('next'))
    assert.deepEqual(store.load(), [record('next')])
  })

  for (const action of ['load', 'save']) check('损坏文件备份失败时 ' + action + ' 拒绝继续并保留原文件', () => {
    const dir = join(root, 'backup-' + action), file = join(dir, 'state.json')
    fs.mkdirSync(dir)
    fs.writeFileSync(file, '{broken')
    fs.renameSync = ((source: unknown, ...args: unknown[]) => {
      if (String(source) === file) throw Object.assign(new Error('BACKUP-FAILED'), { code: 'EIO' })
      return (original.renameSync as (...params: unknown[]) => unknown)(source, ...args)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    const store = new SubAgentStore(dir, 'state')
    assert.throws(() => action === 'load' ? store.load() : store.save(record('next')), /BACKUP-FAILED/)
    restore()
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
    store.save(record('next'))
    assert.deepEqual(store.load(), [record('next')])
    const backup = fs.readdirSync(dir).find((name) => name.startsWith('state.json.corrupt.'))!
    assert.equal(fs.readFileSync(join(dir, backup), 'utf8'), '{broken')
  })

  check('真正不存在的文件可读取空状态并正常首次保存', () => {
    const store = new SubAgentStore(join(root, 'missing'), 'state')
    assert.deepEqual(store.load(), [])
    store.save(record('first'))
    assert.deepEqual(store.load(), [record('first')])
  })
} finally {
  restore()
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_subagent_read_'))
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

console.log('subagent_read_failure_test: ' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
