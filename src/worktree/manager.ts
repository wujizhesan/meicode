import { spawn } from 'node:child_process'
import { existsSync, symlinkSync, copyFileSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync, readFileSync, unlinkSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateWorktreeName } from './validate.ts'
import type { WorktreeInfo } from './types.ts'

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

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot
    this.root = join(repoRoot, '.mewcode', 'worktrees')
    mkdirSync(this.root, { recursive: true })
  }

  getRoot(): string {
    return this.root
  }

  async create(name: string): Promise<WorktreeInfo> {
    if (!validateWorktreeName(name)) {
      throw new Error(`非法 worktree 名称: ${name}`)
    }
    const path = resolve(join(this.root, name))
    // 快速恢复：目录已存在且 git 在册 → 复用（不执行 git 写）
    if (existsSync(path)) {
      const listed = await git(['worktree', 'list', '--porcelain'], this.repoRoot)
      if (listed.out.includes(norm(path))) {
        // 复用后 ff 同步到 main 最新（worktree 创建后 main 的新提交文件才能可见；dirty/冲突时静默保留现状）
        await git(['-C', path, 'merge', '--ff-only', 'main'], this.repoRoot)
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
    // 初始化产物：worktree 内 .gitignore（worktree 专属）+ 主 exclude 附加 .gitignore 自身
    try {
      const mainExclude = join(this.repoRoot, '.git', 'info', 'exclude')
      const existing = existsSync(mainExclude) ? readFileSync(mainExclude, 'utf8') : ''
      if (!existing.includes('.gitignore')) {
        writeFileSync(mainExclude, existing + '\n.gitignore\n', 'utf8')
      }
      writeFileSync(join(path, '.gitignore'), 'node_modules\n.env*\n*.local.*\n', 'utf8')
    } catch {
      // 忽略失败不阻塞
    }
  }

  // 变更检查：tracked 修改或未推送 commit → dirty（untracked 是初始化产物，不算）
  async exit(name: string): Promise<WorktreeInfo> {
    const path = resolve(join(this.root, name))
    if (!existsSync(path)) throw new Error(`worktree 不存在: ${name}`)
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
    return `已删除 worktree: ${name}`
  }

  // 清理过期（>days 且无变更）
  async cleanup(days = 7): Promise<number> {
    let removed = 0
    if (!existsSync(this.root)) return 0
    const dayMs = days * 24 * 3600 * 1000
    for (const entry of readdirSync(this.root)) {
      const path = join(this.root, entry)
      if (!statSync(path).isDirectory()) continue
      const age = Date.now() - statSync(path).mtimeMs
      if (age > dayMs) {
        try {
          const info = await this.exit(entry)
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
        }
      }
    }
    return removed
  }

  // 三层过滤：路径前缀 + 名校验 + git 在册
  async isManagedPath(p: string): Promise<boolean> {
    const resolved = resolve(p)
    if (!resolved.startsWith(this.root + '\\') && !resolved.startsWith(this.root + '/')) return false
    const rel = resolved.slice(this.root.length + 1).split(/[\\/]/)[0]
    if (!validateWorktreeName(rel)) return false
    const listed = await git(['worktree', 'list', '--porcelain'], this.repoRoot)
    return listed.out.includes(norm(resolved))
  }
}

export { validateWorktreeName } from './validate.ts'
export type { WorktreeInfo } from './types.ts'
