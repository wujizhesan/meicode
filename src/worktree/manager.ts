import { spawn } from 'node:child_process'
import { existsSync, symlinkSync, copyFileSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync, readFileSync, unlinkSync, lstatSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { validateWorktreeName } from './validate.ts'
import type { WorktreeInfo } from './types.ts'
import { projectStatePath } from '../state-paths.ts'
import { atomicWriteFile } from '../team/atomic.ts'
import { withLock } from '../team/lock.ts'

const PROCESS_INSTANCE_ID = randomUUID()

interface WorktreeLease {
  pid: number
  ownerId: string
  processInstanceId?: string
  updatedAt?: number
}

interface ProcessMarker {
  processInstanceId: string
  updatedAt?: number
}

function git(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve2) => {
    const child = spawn('git', args, { cwd, shell: false })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => resolve2({ code: code ?? -1, out }))
    child.on('error', () => resolve2({ code: -1, out }))
  })
}

// git 输出路径为正斜杠——Windows 反斜杠需规范化
function norm(p: string): string {
  return p.replaceAll('\\', '/')
}

function worktreePathKey(path: string): string {
  const normalized = norm(resolve(path)).replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

interface GitWorktreeEntry {
  path: string
  branch?: string
  detached: boolean
}

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | null = null
  for (const raw of output.split('\0')) {
    const field = raw.replace(/\r?\n$/, '')
    if (field.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: field.slice('worktree '.length), detached: false }
    } else if (field.startsWith('branch ') && current) {
      current.branch = field.slice('branch '.length)
    } else if (field === 'detached' && current) {
      current.detached = true
    }
  }
  if (current) entries.push(current)
  return entries
}

function findWorktree(output: string, path: string): GitWorktreeEntry | undefined {
  const target = worktreePathKey(path)
  return parseWorktreeList(output).find((entry) => worktreePathKey(entry.path) === target)
}

function hasWorktreePath(output: string, path: string): boolean {
  return findWorktree(output, path) !== undefined
}

function assertWorktreeBranch(entry: GitWorktreeEntry, name: string): void {
  const expected = `refs/heads/wt-${name}`
  if (entry.detached || entry.branch !== expected) {
    const actual = entry.detached ? 'detached HEAD' : entry.branch?.replace(/^refs\/heads\//, '') ?? '未知分支'
    throw new Error(`worktree ${name} 分支不匹配: 期望 wt-${name}，实际 ${actual}`)
  }
}

// 解链 worktree 内 node_modules junction：Windows 上 git/rmSync 递归删除会跟随
// junction 清空主目录 node_modules（实战实锤:删 worktree 后依赖全没）。unlink 只删链接。
function unlinkJunction(dir: string): void {
  const nm = join(dir, 'node_modules')
  try {
    if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) unlinkSync(nm)
  } catch {
    // 解链失败不阻塞删除
  }
}

export class WorktreeManager {
  private root: string // worktrees 根目录
  private repoRoot: string
  private readonly leaseOwnerId = randomUUID()
  private readonly operations = new Set<string>()

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot
    this.root = projectStatePath(repoRoot, 'worktrees')
    this.ensureRepoExcludes()
  }

  getRoot(): string {
    return this.root
  }

  private leaseFile(name: string): string {
    return join(this.root, '.leases', `${createHash('sha256').update(name).digest('hex')}.json`)
  }

  private processMarkerFile(pid: number): string {
    return join(this.root, '.leases', `process-${pid}.json`)
  }

  private ensureProcessMarker(): void {
    const dir = join(this.root, '.leases')
    mkdirSync(dir, { recursive: true })
    atomicWriteFile(this.processMarkerFile(process.pid), JSON.stringify({
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      updatedAt: Date.now(),
    }))
  }

  private readProcessMarker(pid: number): ProcessMarker | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.processMarkerFile(pid), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const marker = parsed as Record<string, unknown>
      if (marker.pid !== pid || typeof marker.processInstanceId !== 'string') return null
      if (marker.updatedAt !== undefined && (typeof marker.updatedAt !== 'number' || !Number.isFinite(marker.updatedAt))) return null
      return {
        processInstanceId: marker.processInstanceId,
        updatedAt: marker.updatedAt as number | undefined,
      }
    } catch {
      return null
    }
  }

  private readLease(name: string): WorktreeLease | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.leaseFile(name), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const lease = parsed as Record<string, unknown>
      if (!Number.isSafeInteger(lease.pid) || (lease.pid as number) <= 0 || typeof lease.ownerId !== 'string') return null
      if (lease.processInstanceId !== undefined && typeof lease.processInstanceId !== 'string') return null
      if (lease.updatedAt !== undefined && (typeof lease.updatedAt !== 'number' || !Number.isFinite(lease.updatedAt))) return null
      return {
        pid: lease.pid as number,
        ownerId: lease.ownerId,
        processInstanceId: lease.processInstanceId as string | undefined,
        updatedAt: lease.updatedAt as number | undefined,
      }
    } catch {
      return null
    }
  }

  private processAlive(pid: number): boolean {
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private leaseAlive(lease: WorktreeLease): boolean {
    if (!this.processAlive(lease.pid)) return false
    const marker = this.readProcessMarker(lease.pid)
    if (lease.processInstanceId) return marker?.processInstanceId === lease.processInstanceId
    if (lease.pid === process.pid) return false
    if (marker?.updatedAt !== undefined && lease.updatedAt !== undefined && marker.updatedAt > lease.updatedAt) return false
    return true
  }

  private acquireLease(name: string, reuseOwned = true): boolean {
    const file = this.leaseFile(name)
    this.ensureProcessMarker()
    let acquired = false
    withLock(`${file}.lock`, () => {
      const current = this.readLease(name)
      if (current && this.leaseAlive(current)) {
        if (reuseOwned && current.ownerId === this.leaseOwnerId) return
        throw new Error(`worktree ${name} 正由其他执行者使用`)
      }
      atomicWriteFile(file, JSON.stringify({
        pid: process.pid,
        ownerId: this.leaseOwnerId,
        processInstanceId: PROCESS_INSTANCE_ID,
        updatedAt: Date.now(),
      }))
      acquired = true
    })
    return acquired
  }

  private claimCleanupLease(name: string): string | null {
    const file = this.leaseFile(name)
    const ownerId = `cleanup-${randomUUID()}`
    this.ensureProcessMarker()
    let claimed = false
    withLock(`${file}.lock`, () => {
      const current = this.readLease(name)
      if (current && this.leaseAlive(current)) return
      atomicWriteFile(file, JSON.stringify({
        pid: process.pid,
        ownerId,
        processInstanceId: PROCESS_INSTANCE_ID,
        updatedAt: Date.now(),
      }))
      claimed = true
    })
    return claimed ? ownerId : null
  }

  private releaseLease(name: string, ownerId: string): void {
    const file = this.leaseFile(name)
    withLock(`${file}.lock`, () => {
      const lease = this.readLease(name)
      if (!lease || lease.ownerId !== ownerId) return
      rmSync(file, { force: true })
    })
  }

  private assertOwnedLease(name: string): void {
    const lease = this.readLease(name)
    if (!lease || lease.ownerId !== this.leaseOwnerId || !this.leaseAlive(lease)) {
      throw new Error(`worktree ${name} 未由当前管理器持有`)
    }
  }

  private beginOperation(name: string): void {
    if (this.operations.has(name)) throw new Error(`worktree ${name} 正在执行其他生命周期操作`)
    this.operations.add(name)
  }

  private endOperation(name: string): void {
    this.operations.delete(name)
  }

  release(name: string): void {
    if (!validateWorktreeName(name)) return
    this.releaseLease(name, this.leaseOwnerId)
  }

  private ensureRepoExcludes(): void {
    try {
      const mainExclude = join(this.repoRoot, '.git', 'info', 'exclude')
      const existing = existsSync(mainExclude) ? readFileSync(mainExclude, 'utf8') : ''
      const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
      let changed = false
      for (const entry of ['.gitignore', '.meicode/', '.mewcode/']) {
        if (lines.has(entry)) continue
        lines.add(entry)
        changed = true
      }
      if (changed) writeFileSync(mainExclude, `${[...lines].join('\n')}\n`, 'utf8')
    } catch {
    }
  }

  async create(name: string): Promise<WorktreeInfo> {
    if (!validateWorktreeName(name)) {
      throw new Error(`非法 worktree 名称: ${name}`)
    }
    this.beginOperation(name)
    let acquired = false
    try {
      this.ensureRepoExcludes()
      mkdirSync(this.root, { recursive: true })
      acquired = this.acquireLease(name)
      const path = resolve(join(this.root, name))
      // 快速恢复：目录已存在且 git 在册 → 复用（不执行 git 写）
      if (existsSync(path)) {
        const listed = await git(['worktree', 'list', '--porcelain', '-z'], this.repoRoot)
        if (listed.code !== 0) throw new Error(`无法读取 git worktree 列表: ${listed.out.slice(0, 300)}`)
        const existing = findWorktree(listed.out, path)
        if (existing) {
          assertWorktreeBranch(existing, name)
          const base = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], this.repoRoot)
          const baseBranch = base.out.trim()
          if (base.code !== 0 || !baseBranch) throw new Error('主仓库处于 detached HEAD，无法同步复用 worktree')
          const synced = await git(['-C', path, 'merge', '--ff-only', baseBranch], this.repoRoot)
          if (synced.code !== 0) throw new Error(`worktree ${name} 无法快进到 ${baseBranch}: ${synced.out.slice(0, 300)}`)
          return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
        }
        throw new Error(`目录已存在但不在 git worktree 列表: ${name}`)
      }
      const res = await git(['worktree', 'add', path, '-b', `wt-${name}`], this.repoRoot)
      if (res.code !== 0) {
        throw new Error(`worktree 创建失败: ${res.out.slice(0, 300)}`)
      }
      await this.initEnvironment(name, path)
      return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
    } catch (error) {
      if (acquired) this.release(name)
      throw error
    } finally {
      this.endOperation(name)
    }
  }

  async attach(name: string, expectedPath?: string): Promise<WorktreeInfo> {
    if (!validateWorktreeName(name)) throw new Error(`非法 worktree 名称: ${name}`)
    this.beginOperation(name)
    let acquired = false
    try {
      const path = resolve(join(this.root, name))
      if (expectedPath && worktreePathKey(expectedPath) !== worktreePathKey(path)) {
        throw new Error(`worktree ${name} 的持久化路径不匹配: ${expectedPath}`)
      }
      if (!existsSync(path)) throw new Error(`worktree 不存在: ${name}`)
      const listed = await git(['worktree', 'list', '--porcelain', '-z'], this.repoRoot)
      if (listed.code !== 0) throw new Error(`无法读取 git worktree 列表: ${listed.out.slice(0, 300)}`)
      const existing = findWorktree(listed.out, path)
      if (!existing) throw new Error(`目录存在但不在 git worktree 列表: ${name}`)
      assertWorktreeBranch(existing, name)
      acquired = this.acquireLease(name, false)
      return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: false }
    } catch (error) {
      if (acquired) this.release(name)
      throw error
    } finally {
      this.endOperation(name)
    }
  }

  // 环境初始化：junction 软链 node_modules + 复制配置文件 + exclude 初始化产物
  //（hooks 由 worktree 天然共享主 .git）
  private async initEnvironment(name: string, path: string): Promise<void> {
    const mainNodeModules = join(this.repoRoot, 'node_modules')
    if (existsSync(mainNodeModules) && !existsSync(join(path, 'node_modules'))) {
      try {
        // 目录符号链接优先:git/rmSync 递归删 worktree 不跟随 symlink(实测),主目录依赖不被清空
        symlinkSync(mainNodeModules, join(path, 'node_modules'), 'dir')
      } catch {
        try {
          // fallback junction(无需权限)——但删除时必须先 unlinkJunction 解链
          symlinkSync(mainNodeModules, join(path, 'node_modules'), 'junction')
        } catch {
          // 软链失败不阻塞
        }
      }
    }
    for (const f of readdirSync(this.repoRoot)) {
      if (f.startsWith('.env') || f.includes('.local.')) {
        try {
          copyFileSync(join(this.repoRoot, f), join(path, f))
        } catch {
          // 忽略
        }
      }
    }
    // 初始化产物：worktree 内 .gitignore（worktree 专属）
    try {
      writeFileSync(join(path, '.gitignore'), 'node_modules\n.env*\n*.local.*\n', 'utf8')
    } catch {
      // 忽略失败不阻塞
    }
  }

  // 变更检查：tracked 修改或未推送 commit → dirty（untracked 是初始化产物，不算）
  async exit(name: string): Promise<WorktreeInfo> {
    if (!validateWorktreeName(name)) throw new Error(`非法 worktree 名称: ${name}`)
    const path = resolve(join(this.root, name))
    if (!existsSync(path)) throw new Error(`worktree 不存在: ${name}`)
    const branch = await git(['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], this.repoRoot)
    const actualBranch = branch.out.trim()
    if (branch.code !== 0 || actualBranch !== `wt-${name}`) {
      throw new Error(`worktree ${name} 分支不匹配: 期望 wt-${name}，实际 ${actualBranch || 'detached HEAD'}`)
    }
    const status = await git(['-C', path, 'status', '--porcelain'])
    // 初始化产物已被 exclude（node_modules/.env*）——剩余 status 输出都是真实变更
    const dirty = status.out.trim().length > 0
    if (!dirty) {
      // 未推送 commit 检查：仅当命令成功且有输出（无 remote 时 128 不算 dirty）
      const log = await git(['-C', path, 'log', `origin/HEAD..wt-${name}`, '--oneline'])
      if (log.code === 0 && log.out.trim().length > 0) {
        return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty: true }
      }
    }
    return { name, path, branch: `wt-${name}`, createdAt: Date.now(), dirty }
  }

  // 保护性删除：dirty 拒绝
  async remove(name: string): Promise<string> {
    if (!validateWorktreeName(name)) throw new Error(`非法 worktree 名称: ${name}`)
    this.beginOperation(name)
    try {
      this.assertOwnedLease(name)
      const info = await this.exit(name)
      if (info.dirty) {
        return `worktree ${name} 有未提交修改或未推送 commit，拒绝删除`
      }
      unlinkJunction(info.path)
      const res = await git(['worktree', 'remove', info.path, '--force'], this.repoRoot)
      if (res.code !== 0) {
        return `删除失败: ${res.out.slice(0, 200)}`
      }
      try {
        rmSync(info.path, { recursive: true, force: true })
      } catch {
        // 物理目录残留不阻塞
      }
      this.release(name)
      return `已删除 worktree: ${name}`
    } finally {
      this.endOperation(name)
    }
  }

  // 清理过期（>days 且无变更）
  async cleanup(days = 7): Promise<number> {
    let removed = 0
    if (!existsSync(this.root)) return 0
    const dayMs = days * 24 * 3600 * 1000
    const listed = await git(['worktree', 'list', '--porcelain', '-z'], this.repoRoot)
    if (listed.code !== 0) return 0
    const rootKey = worktreePathKey(this.root)
    for (const entry of parseWorktreeList(listed.out)) {
      const path = resolve(entry.path)
      const pathKey = worktreePathKey(path)
      if (!pathKey.startsWith(`${rootKey}/`)) continue
      const name = norm(relative(this.root, path))
      if (!validateWorktreeName(name)) continue
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      const age = Date.now() - stats.mtimeMs
      if (age > dayMs) {
        const cleanupLease = this.claimCleanupLease(name)
        if (!cleanupLease) continue
        try {
          const info = await this.exit(name)
          if (!info.dirty) {
            unlinkJunction(path)
            const res = await git(['worktree', 'remove', path, '--force'], this.repoRoot)
            if (res.code === 0) {
              removed++
              try {
                rmSync(path, { recursive: true, force: true })
              } catch {
                // 忽略
              }
            }
          }
        } catch {
          // 单目录失败跳过
        } finally {
          this.releaseLease(name, cleanupLease)
        }
      }
    }
    return removed
  }

  // 三层过滤：路径前缀 + 名校验 + git 在册
  async isManagedPath(p: string): Promise<boolean> {
    const resolved = resolve(p)
    const rootKey = worktreePathKey(this.root)
    if (!worktreePathKey(resolved).startsWith(`${rootKey}/`)) return false
    const rel = norm(relative(this.root, resolved))
    if (!validateWorktreeName(rel)) return false
    const listed = await git(['worktree', 'list', '--porcelain', '-z'], this.repoRoot)
    return listed.code === 0 && hasWorktreePath(listed.out, resolved)
  }
}

export { validateWorktreeName } from './validate.ts'
export type { WorktreeInfo } from './types.ts'
