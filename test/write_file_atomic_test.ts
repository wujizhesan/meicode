import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { writeFileTool } from '../src/tools/write_file.ts'

let passed = 0
let failed = 0
const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_atomic_write_'))
const original = { writeFile: fs.writeFile, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync }
type WriteFunction = (fd: number, content: string, encoding: BufferEncoding, callback: (error: NodeJS.ErrnoException | null) => void) => void
const write = original.writeFile as WriteFunction

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
  } finally {
    restoreFs()
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('写入测试超时')), 3000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function assertNoTemporary(directory: string): void {
  assert(!fs.readdirSync(directory).some((name) => name.startsWith('.meicode-write-')))
}

try {
  for (const stage of ['write', 'partial', 'flush', 'rename'] as const) {
    for (const existing of [false, true]) {
      await check(`${stage} 故障保留${existing ? '原文件' : '不存在的目标'}并清理临时文件`, async () => {
        const directory = join(root, `${stage}-${existing}`)
        fs.mkdirSync(directory)
        const file = join(directory, 'target.txt')
        const before = '原文件内容不能丢失😀'
        if (existing) fs.writeFileSync(file, before)
        const fault = () => Object.assign(new Error(`INJECTED_${stage.toUpperCase()}`), { code: stage === 'write' || stage === 'partial' ? 'ENOSPC' : 'EIO' })
        if (stage === 'write' || stage === 'partial') {
          fs.writeFile = ((fd, _content, _encoding, callback) => {
            if (stage === 'partial') fs.writeSync(fd, Buffer.from('PARTIAL'))
            queueMicrotask(() => callback(fault()))
          }) as WriteFunction as typeof fs.writeFile
        } else if (stage === 'flush') fs.fsyncSync = () => { throw fault() }
        else fs.renameSync = () => { throw fault() }
        syncBuiltinESMExports()
        const result = await writeFileTool.execute({ path: file, content: '新内容' }, { cwd: root, rootLock: root })
        assert.equal(result.success, false)
        assert(result.error?.includes(`INJECTED_${stage.toUpperCase()}`))
        assert.equal(result.evidence, undefined)
        if (existing) assert.equal(fs.readFileSync(file, 'utf8'), before)
        else assert(!fs.existsSync(file))
        assertNoTemporary(directory)
      })
    }
  }

  await check('异步写入完成前读取仍看到原文件，替换后只看到完整新内容', async () => {
    const directory = join(root, 'visibility')
    fs.mkdirSync(directory)
    const file = join(directory, 'target.txt')
    fs.writeFileSync(file, '原内容')
    const content = '新内容😀'.repeat(500)
    let started!: () => void
    const ready = new Promise<void>((done) => { started = done })
    let release = () => {}
    fs.writeFile = ((fd, data, encoding, callback) => {
      write(fd, data, encoding, (error) => { release = () => callback(error); started() })
    }) as WriteFunction as typeof fs.writeFile
    syncBuiltinESMExports()
    const pending = writeFileTool.execute({ path: file, content }, { cwd: root, rootLock: root })
    try {
      await bounded(ready)
      assert.equal(fs.readFileSync(file, 'utf8'), '原内容')
      release()
      const result = await bounded(pending)
      assert.equal(result.success, true)
      assert.equal(fs.readFileSync(file, 'utf8'), content)
      assert(result.output.includes(String(Buffer.byteLength(content))))
      assert.deepEqual(result.evidence?.changedFiles, [file])
      assertNoTemporary(directory)
    } finally {
      release()
      await bounded(pending)
    }
  })

  for (const existing of [false, true]) {
    await check(`临时文件写入后取消时保留${existing ? '原文件' : '不存在的目标'}`, async () => {
      const directory = join(root, `cancel-${existing}`)
      fs.mkdirSync(directory)
      const file = join(directory, 'target.txt')
      if (existing) fs.writeFileSync(file, '原内容')
      const controller = new AbortController()
      fs.writeFile = ((fd, content, encoding, callback) => {
        write(fd, content, encoding, (error) => { controller.abort(); callback(error) })
      }) as WriteFunction as typeof fs.writeFile
      syncBuiltinESMExports()
      const result = await writeFileTool.execute({ path: file, content: '新内容' }, { cwd: root, rootLock: root, signal: controller.signal })
      assert.equal(result.success, false)
      assert(result.error?.includes('取消'))
      if (existing) assert.equal(fs.readFileSync(file, 'utf8'), '原内容')
      else assert(!fs.existsSync(file))
      assertNoTemporary(directory)
    })
  }

  await check('替换保留原文件权限位', async () => {
    const file = join(root, 'permissions.txt')
    fs.writeFileSync(file, 'old')
    fs.chmodSync(file, 0o640)
    const mode = fs.statSync(file).mode & 0o777
    const result = await writeFileTool.execute({ path: file, content: 'new' }, { cwd: root, rootLock: root })
    assert.equal(result.success, true)
    assert.equal(fs.readFileSync(file, 'utf8'), 'new')
    assert.equal(fs.statSync(file).mode & 0o777, mode)
    assertNoTemporary(root)
  })

  if (process.platform === 'win32') {
    await check('只读文件拒绝替换且原内容不变', async () => {
      const file = join(root, 'readonly.txt')
      fs.writeFileSync(file, 'old')
      fs.chmodSync(file, 0o444)
      try {
        const result = await writeFileTool.execute({ path: file, content: 'new' }, { cwd: root, rootLock: root })
        assert.equal(result.success, false)
        assert.equal(fs.readFileSync(file, 'utf8'), 'old')
        assertNoTemporary(root)
      } finally { fs.chmodSync(file, 0o666) }
    })
  }

  await check('目录链接写入更新真实目标并保留链接', async () => {
    const actual = join(root, 'actual')
    const link = join(root, 'linked')
    fs.mkdirSync(actual)
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const result = await writeFileTool.execute({ path: join(link, 'target.txt'), content: '链接中的内容' }, { cwd: root, rootLock: root })
      assert.equal(result.success, true)
      assert.equal(fs.readFileSync(join(actual, 'target.txt'), 'utf8'), '链接中的内容')
      assert(fs.lstatSync(link).isSymbolicLink())
      assertNoTemporary(actual)
      // POSIX 的符号链接必须用 unlink 删除（rmdir 会报 ENOTDIR）；Windows 的 junction 才是目录语义
    } finally { process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link) }
  })

  await check('目标是目录时保留目录及内容', async () => {
    const directory = join(root, 'not-file')
    fs.mkdirSync(directory)
    fs.writeFileSync(join(directory, 'keep.txt'), 'keep')
    const result = await writeFileTool.execute({ path: directory, content: 'new' }, { cwd: root, rootLock: root })
    assert.equal(result.success, false)
    assert.equal(fs.readFileSync(join(directory, 'keep.txt'), 'utf8'), 'keep')
    assertNoTemporary(root)
  })
} finally {
  restoreFs()
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_atomic_write_'))
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
