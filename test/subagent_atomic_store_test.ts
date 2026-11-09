import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join, relative, resolve, sep } from 'node:path'
import { SubAgentStore } from '../src/subagent/store.ts'
import type { SubAgentRecord } from '../src/subagent/types.ts'

let passed = 0
let failed = 0
const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_subagent_atomic_'))
const original = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync }

function restoreFs(): void {
  Object.assign(fs, original)
  syncBuiltinESMExports()
}

async function check(name: string, test: () => void): Promise<void> {
  try {
    test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  } finally { restoreFs() }
}

function record(id: string): SubAgentRecord {
  return { id, role: 'worker', type: 'fork', status: 'done', startedAt: 1, result: '已完成😀' }
}

function fault(stage: 'write' | 'partial' | 'flush' | 'rename'): void {
  let temporary: number | undefined
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args)
    if (typeof args[0] === 'string' && basename(args[0]).startsWith('.meicode-write-')) temporary = fd
    return fd
  }) as typeof fs.openSync
  const error = () => Object.assign(new Error(`INJECTED_${stage.toUpperCase()}`), { code: stage === 'write' || stage === 'partial' ? 'ENOSPC' : 'EIO' })
  if (stage === 'write' || stage === 'partial') {
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === temporary) {
        if (stage === 'partial') fs.writeSync(args[0] as number, Buffer.from('[BROKEN'))
        throw error()
      }
      original.writeFileSync(...args)
    }) as typeof fs.writeFileSync
  } else if (stage === 'flush') {
    fs.fsyncSync = (fd) => { if (fd === temporary) throw error(); original.fsyncSync(fd) }
  } else fs.renameSync = () => { throw error() }
  syncBuiltinESMExports()
}

function assertNoTemporary(directory: string): void {
  assert(!fs.readdirSync(directory).some((name) => name.startsWith('.meicode-write-')))
}

try {
  for (const stage of ['write', 'partial', 'flush', 'rename'] as const) {
    for (const existing of [false, true]) {
      await check(`${stage} 失败保留${existing ? '原状态文件' : '缺省状态'}，清理临时文件且后续保存可用`, () => {
        const directory = join(root, `${stage}-${existing}`)
        const store = new SubAgentStore(directory, 'state')
        const file = join(directory, 'state.json')
        const first = record('original')
        if (existing) store.save(first)
        const before = existing ? fs.readFileSync(file, 'utf8') : undefined
        fault(stage)
        assert.throws(() => store.save(record('next')), new RegExp(`INJECTED_${stage.toUpperCase()}`))
        restoreFs()
        if (existing) assert.equal(fs.readFileSync(file, 'utf8'), before)
        else assert(!fs.existsSync(file))
        assert.deepEqual(store.load(), existing ? [first] : [])
        assert.deepEqual(new SubAgentStore(directory, 'state').load(), existing ? [first] : [])
        assertNoTemporary(directory)
        store.save(record('next'))
        assert.deepEqual(store.load().map((item) => item.id), existing ? ['original', 'next'] : ['next'])
        assertNoTemporary(directory)
      })
    }
  }

  for (const operation of ['renew', 'requestCancel', 'cancelOwned', 'reclaim'] as const) {
    await check(`${operation} 保存失败时缓存与持久化均保持原记录`, () => {
      const directory = join(root, `cache-${operation}`)
      const store = new SubAgentStore(directory, 'state')
      const first: SubAgentRecord = { ...record('active'), status: 'running', ownerId: 'owner', leaseExpiresAt: 10 }
      store.save(first)
      const file = join(directory, 'state.json')
      const before = fs.readFileSync(file, 'utf8')
      fault('rename')
      assert.throws(() => {
        if (operation === 'renew') store.renewLease('active', 'owner', 100)
        else if (operation === 'requestCancel') store.requestCancel('active', '取消', 20)
        else if (operation === 'cancelOwned') store.cancelOwned('active', 'owner')
        else store.reclaimExpired('active', 20)
      }, /INJECTED_RENAME/)
      restoreFs()
      assert.equal(fs.readFileSync(file, 'utf8'), before)
      assert.deepEqual(store.get('active'), first)
      assert.deepEqual(new SubAgentStore(directory, 'state').get('active'), first)
      assertNoTemporary(directory)
    })
  }

  await check('相对路径状态仓可写，更新保留权限与有效 JSON', () => {
    const directory = join(root, 'relative')
    const store = new SubAgentStore(relative(process.cwd(), directory), 'state')
    store.save(record('first'))
    const file = join(directory, 'state.json')
    fs.chmodSync(file, 0o640)
    const mode = fs.statSync(file).mode & 0o777
    store.save(record('second'))
    assert.equal(fs.statSync(file).mode & 0o777, mode)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((item: SubAgentRecord) => item.id), ['first', 'second'])
    assertNoTemporary(directory)
  })
} finally {
  restoreFs()
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_subagent_atomic_'))
  const verify = (directory: string) => {
    assert(!fs.lstatSync(directory).isSymbolicLink())
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) verify(join(directory, entry.name))
    }
  }
  verify(target)
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
