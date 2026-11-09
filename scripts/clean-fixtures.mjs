// 清理测试运行遗留的产物。
//
// 测试用 mkdtempSync 在 test/ 下建临时夹具（test/fixtures_*），正常路径由各测试
// 自行删除，但进程被 kill、超时或断言中断时不会走到清理逻辑，于是不断堆积
// （实测曾累积 262 个目录 / 85MB）。
//
// 另外，worktree 相关测试会把 worktree 注册写进**主仓库**的 .git/worktrees
// （夹具 git init 失败时 git 会向上解析到主仓库）。目录删掉后这些注册会变成
// 永久 stale，因此这里一并回收——只处理指向 test/fixtures_* 且目录已不存在的条目。
//
// test/fixtures_mcp 是仓库跟踪的源码夹具，必须保留；其余 fixtures_* 均在
// .gitignore 中，属可丢弃产物。
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const testDir = resolve(import.meta.dirname, '..', 'test')
const KEEP = new Set(['fixtures_mcp'])

function toPosix(value) {
  return value.replace(/\\/g, '/')
}

export function cleanFixtureDirs(dir = testDir) {
  if (!existsSync(dir)) return []
  const removed = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('fixtures_')) continue
    if (KEEP.has(entry.name)) continue
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      removed.push(entry.name)
    } catch {
      // 被占用等瞬时失败不影响本轮测试，留给下次清理
    }
  }
  return removed
}

export function pruneFixtureWorktrees(dir = testDir) {
  const adminDir = join(resolve(dir, '..'), '.git', 'worktrees')
  if (!existsSync(adminDir)) return []
  const fixturePrefix = `${toPosix(join(dir, 'fixtures_'))}`
  const removed = []
  for (const entry of readdirSync(adminDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryDir = join(adminDir, entry.name)
    let recorded
    try {
      recorded = readFileSync(join(entryDir, 'gitdir'), 'utf8').trim()
    } catch {
      continue
    }
    if (!recorded) continue
    // gitdir 指向 worktree 内的 .git 文件，可能是相对路径
    const gitFile = resolve(entryDir, recorded)
    if (!toPosix(gitFile).startsWith(fixturePrefix)) continue // 非夹具 worktree，不动
    if (existsSync(gitFile)) continue // 工作目录仍在，说明注册有效
    try {
      rmSync(entryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      removed.push(entry.name)
    } catch {
      // 同上，留给下次
    }
  }
  return removed
}

export function cleanFixtures(dir = testDir) {
  return { dirs: cleanFixtureDirs(dir), worktrees: pruneFixtureWorktrees(dir) }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { dirs, worktrees } = cleanFixtures()
  process.stdout.write(`回收测试夹具: ${dirs.length} 个目录，${worktrees.length} 个 worktree 注册\n`)
}
