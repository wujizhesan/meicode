// Worktree 测试：校验/创建/恢复/保护/清理
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

  await check('租约: PID 复用不会让旧进程租约永久阻塞', async () => {
    const name = 'pid-reuse'
    const leaseDir = join(manager.getRoot(), '.leases')
    const leaseFile = join(leaseDir, `${createHash('sha256').update(name).digest('hex')}.json`)
    mkdirSync(leaseDir, { recursive: true })
    writeFileSync(leaseFile, JSON.stringify({
      pid: process.pid,
      ownerId: 'stale-owner',
      processInstanceId: 'stale-process-instance',
      updatedAt: Date.now(),
    }), 'utf8')
    const wt = await manager.create(name)
    if (!existsSync(wt.path)) throw new Error('PID 复用租约未被接管')
    await manager.remove(name)
  })

  await check('租约: 旧格式同 PID 租约会在升级后迁移', async () => {
    const name = 'legacy-pid-reuse'
    const leaseDir = join(manager.getRoot(), '.leases')
    const leaseFile = join(leaseDir, `${createHash('sha256').update(name).digest('hex')}.json`)
    mkdirSync(leaseDir, { recursive: true })
    writeFileSync(leaseFile, JSON.stringify({
      pid: process.pid,
      ownerId: 'legacy-stale-owner',
      updatedAt: Date.now() - 1000,
    }), 'utf8')
    const wt = await manager.create(name)
    if (!existsSync(wt.path)) throw new Error('旧格式同 PID 租约未被接管')
    await manager.remove(name)
  })

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
  await check('租约: 其他管理器不能复用活动 worktree', async () => {
    const contender = new WorktreeManager(repo)
    let rejected = false
    try {
      await contender.create('refactorer')
    } catch (error) {
      rejected = (error as Error).message.includes('其他执行者使用')
    }
    if (!rejected) throw new Error('活动 worktree 被其他管理器复用')
    let removeRejected = false
    try {
      await contender.remove('refactorer')
    } catch (error) {
      removeRejected = (error as Error).message.includes('未由当前管理器持有')
    }
    if (!removeRejected || !existsSync(join(manager.getRoot(), 'refactorer'))) throw new Error('其他管理器删除了活动 worktree')
  })
  await check('租约: 同一管理器并发创建不会释放成功调用的租约', async () => {
    const outcomes = await Promise.allSettled([manager.create('concurrent'), manager.create('concurrent')])
    if (outcomes.filter((result) => result.status === 'fulfilled').length !== 1 || outcomes.filter((result) => result.status === 'rejected').length !== 1) {
      throw new Error(`并发创建结果异常: ${outcomes.map((result) => result.status).join(',')}`)
    }
    const contender = new WorktreeManager(repo)
    let rejected = false
    try {
      await contender.create('concurrent')
    } catch (error) {
      rejected = (error as Error).message.includes('其他执行者使用')
    }
    if (!rejected) throw new Error('失败的并发创建释放了成功调用的租约')
    await manager.remove('concurrent')
  })
  await check('租约: 恢复附着后阻止其他管理器接管', async () => {
    const created = await manager.create('restored')
    manager.release('restored')
    const restored = new WorktreeManager(repo)
    await restored.attach('restored', created.path)
    const contender = new WorktreeManager(repo)
    let rejected = false
    try {
      await contender.create('restored')
    } catch (error) {
      rejected = (error as Error).message.includes('其他执行者使用')
    }
    if (!rejected) throw new Error('恢复附着未重新获取租约')
    await restored.remove('restored')
  })
  await check('恢复附着: 拒绝路径正确但真实分支不匹配', async () => {
    const created = await manager.create('branch-check')
    manager.release('branch-check')
    spawnSync('git', ['-C', created.path, 'checkout', '-b', 'unexpected'], { cwd: repo })
    const restored = new WorktreeManager(repo)
    let rejected = false
    try {
      await restored.attach('branch-check', created.path)
    } catch (error) {
      rejected = (error as Error).message.includes('分支不匹配')
    }
    if (!rejected) throw new Error('错误分支被冒充为预期 worktree')
    spawnSync('git', ['-C', created.path, 'checkout', 'wt-branch-check'], { cwd: repo })
    await restored.attach('branch-check', created.path)
    await restored.remove('branch-check')
  })
  await check('cleanup: 嵌套 worktree 可递归清理', async () => {
    const nested = await manager.create('nest/child')
    manager.release('nest/child')
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    utimesSync(nested.path, past, past)
    const removed = await manager.cleanup(7)
    if (removed < 1 || existsSync(nested.path)) throw new Error(`嵌套 worktree 未清理: ${removed}`)
  })
  await check('快速恢复: 跟随当前非 main 分支', async () => {
    spawnSync('git', ['checkout', '-b', 'develop'], { cwd: repo })
    const wt = await manager.create('develop-worker')
    writeFileSync(join(repo, 'develop.txt'), 'develop branch', 'utf8')
    spawnSync('git', ['add', '-A'], { cwd: repo })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'develop update'], { cwd: repo })
    await manager.create('develop-worker')
    if (!existsSync(join(wt.path, 'develop.txt'))) throw new Error('复用 worktree 未同步当前 develop 分支')
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    if (!exclude.includes('.meicode/') || !exclude.includes('.mewcode/')) throw new Error('状态目录未加入仓库 exclude')
    const prefixPath = join(manager.getRoot(), 'develop')
    mkdirSync(prefixPath)
    if (await manager.isManagedPath(prefixPath)) throw new Error('worktree 路径前缀被误判为已注册路径')
    let prefixRejected = false
    try {
      await manager.create('develop')
    } catch (error) {
      prefixRejected = (error as Error).message.includes('不在 git worktree 列表')
    }
    if (!prefixRejected) throw new Error('未注册的 worktree 前缀目录被错误复用')
    rmSync(prefixPath, { recursive: true, force: true })
    const removed = await manager.remove('develop-worker')
    if (!removed.includes('已删除')) throw new Error(`非 main worktree 清理失败: ${removed}`)
  })
  await check('exit: 干净与 dirty 检测', async () => {
    const clean = await manager.exit('refactorer')
    if (clean.dirty) throw new Error('干净应为 false')
    writeFileSync(join(repo, '.meicode', 'worktrees', 'refactorer', 'changed.txt'), 'x', 'utf8')
    const dirty = await manager.exit('refactorer')
    if (!dirty.dirty) throw new Error('有变更应为 dirty')
  })
  await check('remove: dirty 拒绝', async () => {
    const msg = await manager.remove('refactorer')
    if (!msg.includes('拒绝删除')) throw new Error(`应拒绝: ${msg}`)
  })
  await check('cleanup: 过期干净清理', async () => {
    // 清掉变更 → 干净 → 清理
    rmSync(join(repo, '.meicode', 'worktrees', 'refactorer', 'changed.txt'), { force: true })
    // 伪造 mtime 7 天前
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    const dir = join(repo, '.meicode', 'worktrees', 'refactorer')
    spawnSync('git', ['-C', dir, 'checkout', '--', '.'], { cwd: repo })
    spawnSync('powershell', ['-Command', `(Get-Item '${dir}').LastWriteTime = Get-Date '2020-01-01'`])
    manager.release('refactorer')
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
