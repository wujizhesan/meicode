import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock, releaseFileLock, withFileLock } from '../src/runtime/file-lock.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-file-lock-'))
const lockFile = join(root, 'shared.lock')
const queueDir = `${lockFile}.queue`
const counterFile = join(root, 'counter.txt')

try {
  const fastLease = acquireFileLock(lockFile)
  if (!existsSync(lockFile) || existsSync(queueDir)) throw new Error('无竞争锁未走独占快路径')
  releaseFileLock(fastLease)
  if (existsSync(lockFile)) throw new Error('独占快路径未释放锁文件')

  mkdirSync(queueDir)
  const queuedLease = acquireFileLock(lockFile)
  if (!existsSync(queueDir) || existsSync(lockFile)) throw new Error('现有队列未走票据锁路径')
  releaseFileLock(queuedLease)
  if (existsSync(queueDir)) throw new Error('票据锁未清理队列')

  writeFileSync(lockFile, JSON.stringify({ owner: 'stale', ts: Date.now() - 60_000 }))
  let staleEntered = false
  withFileLock(lockFile, () => { staleEntered = true })
  if (!staleEntered || existsSync(lockFile)) throw new Error('过期锁未被重新获取并清理')
  withFileLock(lockFile, () => writeFileSync(lockFile, JSON.stringify({ owner: 'replacement', ts: Date.now() })))
  if (!existsSync(lockFile)) throw new Error('旧持有者删除了替换后的锁')
  rmSync(lockFile)

  writeFileSync(counterFile, '0')
  const moduleUrl = new URL('../src/runtime/file-lock.ts', import.meta.url).href
  const worker = `
    import { readFileSync, writeFileSync } from 'node:fs'
    import { withFileLock } from ${JSON.stringify(moduleUrl)}
    const wait = new Int32Array(new SharedArrayBuffer(4))
    for (let index = 0; index < Number(process.argv[3]); index++) {
      withFileLock(process.argv[1], () => {
        const current = Number(readFileSync(process.argv[2], 'utf8'))
        Atomics.wait(wait, 0, 0, 1)
        writeFileSync(process.argv[2], String(current + 1))
      })
    }
  `
  const runWorker = (): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, lockFile, counterFile, '20'], {
      cwd: join(import.meta.dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`锁竞争子进程失败 (${code}): ${stderr}`)))
  })
  await Promise.all(Array.from({ length: 4 }, () => runWorker()))
  if (readFileSync(counterFile, 'utf8') !== '80') throw new Error('多进程锁竞争丢失了计数更新')
  if (existsSync(lockFile) || existsSync(queueDir)) throw new Error('多进程竞争后遗留锁文件')

  // 慢队列仍在前进时不放弃：16 个子进程各持锁 400ms，串行总量约 6.4s——远超默认
  // 5s 预算，但只要每次交接都在预算窗口内发生（队列在前进），排队方就应继续等待
  const slowLockFile = join(root, 'slow.lock')
  const slowWorker = `
    import { withFileLock } from ${JSON.stringify(moduleUrl)}
    const wait = new Int32Array(new SharedArrayBuffer(4))
    withFileLock(process.argv[1], () => { Atomics.wait(wait, 0, 0, 400) })
  `
  const runSlowWorker = (): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', slowWorker, slowLockFile], {
      cwd: join(import.meta.dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`慢队列子进程失败 (${code}): ${stderr}`)))
  })
  await Promise.all(Array.from({ length: 16 }, () => runSlowWorker()))
  if (existsSync(slowLockFile) || existsSync(`${slowLockFile}.queue`)) throw new Error('慢队列竞争后遗留锁文件')

  // 卡死的持有者：队列静止时按预算快速失败，报错要能区分「被占用」与「真失败」
  const stuckFile = join(root, 'stuck.lock')
  const stuckLease = acquireFileLock(stuckFile)
  const stuckBegin = Date.now()
  let stuckError = ''
  try {
    acquireFileLock(stuckFile, { timeoutMs: 400 })
    throw new Error('卡死锁未按预期失败')
  } catch (error) {
    stuckError = String(error)
  }
  if (!stuckError.includes('无法获取锁') || !stuckError.includes('未被释放')) throw new Error(`卡死锁的报错不可诊断: ${stuckError}`)
  if (Date.now() - stuckBegin > 3000) throw new Error(`卡死锁失败过慢 (${Date.now() - stuckBegin}ms): 超时预算未生效`)
  releaseFileLock(stuckLease)
  if (existsSync(stuckFile) || existsSync(`${stuckFile}.queue`)) throw new Error('卡死锁用例遗留锁文件')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('file_lock_test passed')
