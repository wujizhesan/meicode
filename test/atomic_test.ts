import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join, resolve, sep } from 'node:path'
import { atomicWriteFile } from '../src/team/atomic.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => void | Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}

const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_atomic_'))
const originalRename = fs.renameSync
const file = (name: string) => join(root, name)
const seed = (name: string, content = 'OLD') => { const target = file(name); fs.writeFileSync(target, content); return target }
const read = (target: string) => fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '<缺失>'
// 只把本用例自己的临时文件算作残留（.tmp / .bak 都以目标文件名为前缀）
const leftovers = (target: string) => fs.readdirSync(root)
  .filter((name) => name.startsWith(`${basename(target)}.`) && (name.endsWith('.tmp') || name.endsWith('.bak')))
const withRename = (patch: typeof fs.renameSync, run: () => void) => {
  fs.renameSync = patch
  syncBuiltinESMExports()
  try { run() } finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
}

try {
  await check('替换成功后内容更新，且不残留临时文件', () => {
    const target = seed('plain.json')
    atomicWriteFile(target, 'NEW')
    assert.equal(read(target), 'NEW')
    assert.deepEqual(leftovers(target), [])
  })

  await check('目标不存在时创建上级目录并写入', () => {
    const target = file(join('nested', 'deep.json'))
    atomicWriteFile(target, 'FRESH')
    assert.equal(read(target), 'FRESH')
    assert.deepEqual(leftovers(target), [])
  })

  await check('覆盖已存在目标被拒绝时，移开策略仍能完成替换', () => {
    const target = seed('busy.json')
    // 模拟 Windows + Node 20：replace 一个已存在（且可能被其它句柄占用）的目标会被拒绝
    withRename(((source, destination) => {
      if (destination === target && fs.existsSync(target)) throw Object.assign(new Error('EPERM: destination busy'), { code: 'EPERM' })
      return originalRename(source, destination)
    }) as typeof fs.renameSync, () => atomicWriteFile(target, 'NEW'))
    assert.equal(read(target), 'NEW')
    assert.deepEqual(leftovers(target), [])
  })

  await check('目标不是普通文件时拒绝替换，且不移动目标', () => {
    const target = file('directory-target')
    fs.mkdirSync(target)
    fs.writeFileSync(join(target, 'inner.txt'), 'KEEP')
    let thrown: unknown
    try { atomicWriteFile(target, 'invalid') } catch (error) { thrown = error }
    assert.ok(thrown, '目标是目录时必须拒绝替换')
    assert.ok(fs.statSync(target).isDirectory(), '目录必须原样保留')
    assert.equal(fs.readFileSync(join(target, 'inner.txt'), 'utf8'), 'KEEP', '目录内容不得被移走')
    assert.deepEqual(leftovers(target), [])
  })

  await check('替换彻底失败时原文件必须完好，且不残留临时文件', () => {
    const target = seed('blocked.json')
    let thrown: unknown
    withRename((() => { throw Object.assign(new Error('EPERM: rename blocked'), { code: 'EPERM' }) }) as typeof fs.renameSync, () => {
      thrown = undefined
      try { atomicWriteFile(target, 'NEW') } catch (error) { thrown = error }
    })
    // 关键不变量：失败不得破坏原文件——历史上这里会先删掉原文件，随后恢复也失败，
    // 只剩一个 .bak，读取方看到的是空文件。
    assert.equal(read(target), 'OLD')
    assert.ok(thrown, '替换失败必须抛错，而不是静默成功')
    assert.match(String(thrown), /EPERM/)
    assert.deepEqual(leftovers(target), [])
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_atomic_'))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`原子写入: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
