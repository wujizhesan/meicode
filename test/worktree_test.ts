// Worktree 测试：校验/创建/恢复/保护/清理
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WorktreeManager, validateWorktreeName } from '../src/worktree/index.ts'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

const TMP = join(import.meta.dirname, 'fixtures_wt')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

function gitInit(dir: string): void {
  spawnSync('git', ['init', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { cwd: dir })
}

async function main() {
  // ---------- 名校验 ----------
  await check('校验: 合法/非法名', () => {
    for (const ok of ['refactorer', 'my-agent', 'nest/child', 'a_b-c1']) {
      if (!validateWorktreeName(ok)) throw new Error(`应合法: ${ok}`)
    }
    for (const bad of ['..', '.', 'a/../b', 'C:', 'C:/x', '/abs', 'a\\b', 'x'.repeat(65), 'a b', 'a$b']) {
      if (validateWorktreeName(bad)) throw new Error(`应拒绝: ${bad}`)
    }
  })

  // ---------- 创建/复用/保护/清理 ----------
  const repo = join(TMP, 'repo')
  mkdirSync(repo, { recursive: true })
  gitInit(repo)
  // node_modules 存在以测软链
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'x.js'), 'x', 'utf8')
  writeFileSync(join(repo, '.env.local'), 'SECRET=1', 'utf8')

  const manager = new WorktreeManager(repo)

  await check('创建: worktree 目录与分支', async () => {
    const wt = await manager.create('refactorer')
    if (!existsSync(join(wt.path, 'README.md'))) throw new Error('文件未检出')
    if (!existsSync(join(wt.path, 'node_modules'))) throw new Error('node_modules 软链缺失')
    if (!existsSync(join(wt.path, '.env.local'))) throw new Error('.env.local 复制缺失')
    const list = spawnSync('git', ['worktree', 'list'], { cwd: repo }).stdout.toString()
    if (!list.includes('wt-refactorer')) throw new Error(`分支缺失: ${list}`)
  })
  await check('快速恢复: 已存在复用不重复 add', async () => {
    const before = spawnSync('git', ['worktree', 'list'], { cwd: repo }).stdout.toString().split('\n').length
    await manager.create('refactorer')
    const after = spawnSync('git', ['worktree', 'list'], { cwd: repo }).stdout.toString().split('\n').length
    if (after !== before) throw new Error('重复创建了 worktree')
  })
  await check('exit: 干净与 dirty 检测', async () => {
    const clean = await manager.exit('refactorer')
    if (clean.dirty) throw new Error('干净应为 false')
    writeFileSync(join(repo, '.mewcode', 'worktrees', 'refactorer', 'changed.txt'), 'x', 'utf8')
    const dirty = await manager.exit('refactorer')
    if (!dirty.dirty) throw new Error('有变更应为 dirty')
  })
  await check('remove: dirty 拒绝', async () => {
    const msg = await manager.remove('refactorer')
    if (!msg.includes('拒绝删除')) throw new Error(`应拒绝: ${msg}`)
  })
  await check('cleanup: 过期干净清理', async () => {
    // 清掉变更 → 干净 → 清理
    rmSync(join(repo, '.mewcode', 'worktrees', 'refactorer', 'changed.txt'), { force: true })
    // 伪造 mtime 7 天前
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    const dir = join(repo, '.mewcode', 'worktrees', 'refactorer')
    spawnSync('git', ['-C', dir, 'checkout', '--', '.'], { cwd: repo })
    spawnSync('powershell', ['-Command', `(Get-Item '${dir}').LastWriteTime = Get-Date '2020-01-01'`])
    const removed = await manager.cleanup(7)
    if (removed < 1) throw new Error(`应清理: ${removed}`)
    // junction 回归：删除 worktree 不得清空主目录 node_modules（Windows 递归删跟随 junction 实锤）
    if (!existsSync(join(repo, 'node_modules', 'x.js'))) {
      throw new Error('删除 worktree 后主目录 node_modules 被清空(junction 跟随删除)')
    }
  })
  await check('isManagedPath: 三层过滤', async () => {
    const wt = await manager.create('second')
    if (!(await manager.isManagedPath(wt.path))) throw new Error('合法路径应通过')
    if (await manager.isManagedPath(join(repo, 'README.md'))) throw new Error('仓库内非 worktree 应拒绝')
    if (await manager.isManagedPath('D:/Windows/system32')) throw new Error('外部路径应拒绝')
    await manager.remove('second')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('worktree 测试异常:', e)
  process.exit(1)
})
