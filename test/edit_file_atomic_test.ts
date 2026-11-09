import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join, resolve, sep } from 'node:path'
import { editFileTool } from '../src/tools/edit_file.ts'

let passed = 0
let failed = 0
const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_atomic_edit_'))
const original = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync }

function restoreFs(): void {
  Object.assign(fs, original)
  syncBuiltinESMExports()
}

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  } finally { restoreFs() }
}

function captureTemporary(): () => number | undefined {
  let temporary: number | undefined
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args)
    if (typeof args[0] === 'string' && basename(args[0]).startsWith('.meicode-write-')) temporary = fd
    return fd
  }) as typeof fs.openSync
  return () => temporary
}

function assertNoTemporary(directory: string): void {
  assert(!fs.readdirSync(directory).some((name) => name.startsWith('.meicode-write-')))
}

try {
  for (const stage of ['write', 'partial', 'flush', 'rename'] as const) {
    await check(`${stage} 故障保留完整原文，清理临时文件且允许再次编辑`, async () => {
      const directory = join(root, stage)
      fs.mkdirSync(directory)
      const file = join(directory, 'target.txt')
      const before = '前文😀\n唯一原文\n后文'
      fs.writeFileSync(file, before)
      const temporary = captureTemporary()
      const fault = () => Object.assign(new Error(`INJECTED_${stage.toUpperCase()}`), { code: stage === 'write' || stage === 'partial' ? 'ENOSPC' : 'EIO' })
      if (stage === 'write' || stage === 'partial') {
        fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
          if (args[0] === temporary()) {
            if (stage === 'partial') fs.writeSync(args[0] as number, Buffer.from('PARTIAL'))
            throw fault()
          }
          original.writeFileSync(...args)
        }) as typeof fs.writeFileSync
      } else if (stage === 'flush') {
        fs.fsyncSync = (fd) => { if (fd === temporary()) throw fault(); original.fsyncSync(fd) }
      } else fs.renameSync = () => { throw fault() }
      syncBuiltinESMExports()
      const result = await editFileTool.execute({ path: file, old_text: '唯一原文', new_text: '新文' }, { cwd: root, rootLock: root })
      assert.equal(result.success, false)
      assert(result.error?.includes(`INJECTED_${stage.toUpperCase()}`))
      assert.equal(result.evidence, undefined)
      assert.equal(fs.readFileSync(file, 'utf8'), before)
      assertNoTemporary(directory)
      restoreFs()
      const retry = await editFileTool.execute({ path: file, old_text: '唯一原文', new_text: '新文' }, { cwd: root, rootLock: root })
      assert.equal(retry.success, true, retry.error ?? '重试编辑失败')
      assert.equal(fs.readFileSync(file, 'utf8'), before.replace('唯一原文', '新文'))
      assertNoTemporary(directory)
    })
  }

  await check('临时文件写完后取消，原文不变且后续编辑可用', async () => {
    const file = join(root, 'cancel.txt')
    fs.writeFileSync(file, '原文')
    const controller = new AbortController()
    const temporary = captureTemporary()
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      original.writeFileSync(...args)
      if (args[0] === temporary()) controller.abort()
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    const result = await editFileTool.execute({ path: file, old_text: '原文', new_text: '新文' }, { cwd: root, rootLock: root, signal: controller.signal })
    assert.equal(result.success, false)
    assert(result.error?.includes('取消'))
    assert.equal(fs.readFileSync(file, 'utf8'), '原文')
    assertNoTemporary(root)
    restoreFs()
    const retry = await editFileTool.execute({ path: file, old_text: '原文', new_text: '后续编辑' }, { cwd: root, rootLock: root })
    assert.equal(retry.success, true, retry.error ?? '重试编辑失败')
    assert.equal(fs.readFileSync(file, 'utf8'), '后续编辑')
  })

  await check('精确编辑保留权限、UTF-8 内容与变更证据', async () => {
    const file = join(root, 'permissions.txt')
    fs.writeFileSync(file, '中文原文😀结尾')
    fs.chmodSync(file, 0o640)
    const mode = fs.statSync(file).mode & 0o777
    const result = await editFileTool.execute({ path: file, old_text: '原文😀', new_text: '替换内容😊' }, { cwd: root, rootLock: root })
    assert.equal(result.success, true, result.error ?? '精确编辑失败')
    assert.equal(fs.readFileSync(file, 'utf8'), '中文替换内容😊结尾')
    assert.equal(fs.statSync(file).mode & 0o777, mode)
    assert.deepEqual(result.evidence?.changedFiles, [file])
    assertNoTemporary(root)
  })
} finally {
  restoreFs()
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_atomic_edit_'))
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
