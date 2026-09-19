import { readFileSync, rmSync, openSync, closeSync, statSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const LOCK_TTL_MS = 30000
const MAX_RETRY = 50

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

// 文件锁：open('wx') 原子创建（跨进程无竞态）；已存在且 <TTL → 重试；>TTL → 过期覆盖
export function withLock(lockFile: string, fn: () => void): void {
  let acquired = false
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx')
      closeSync(fd)
      acquired = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        mkdirSync(dirname(lockFile), { recursive: true })
        continue
      }
      // 已存在：检查 TTL
    }
    let ts: number | null = null
    try {
      const value = Number(readFileSync(lockFile, 'utf8'))
      if (Number.isFinite(value) && value > 0) ts = value
    } catch {
    }
    if (ts === null) {
      try {
        ts = statSync(lockFile).mtimeMs
      } catch {
      }
    }
    if (ts !== null && Date.now() - ts > LOCK_TTL_MS) {
      try {
        rmSync(lockFile, { force: true })
        const fd = openSync(lockFile, 'wx')
        closeSync(fd)
        acquired = true
        break
      } catch {
        // 竞争失败：下一轮重试
      }
    }
    sleepSync(100)
  }
  if (!acquired) {
    throw new Error(`无法获取锁: ${lockFile}`)
  }
  try {
    fn()
  } finally {
    rmSync(lockFile, { force: true })
  }
}
