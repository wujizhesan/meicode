import { existsSync, lstatSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { projectStatePath, projectStateRoot } from '../state-paths.ts'

// execFileSync 不经 shell——参数含空格/中文不被分词(commit message 会含空格)
function git(args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, out }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { code: err.status ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

function rollbackStateFile(cwd: string): string {
  return projectStatePath(cwd, 'rollback-state.json')
}

function checkoutConflict(cwd: string, tree: string, reservedPath?: string): string | null {
  const target = git(['ls-tree', '-r', '-z', '--name-only', tree], cwd)
  const tracked = git(['ls-files', '-z', '--cached'], cwd)
  if (target.code !== 0 || tracked.code !== 0) return `检查未跟踪文件冲突失败: ${(target.out || tracked.out).slice(0, 200)}`
  const trackedPaths = new Set(tracked.out.split('\0'))
  for (const path of target.out.split('\0')) {
    if (path === reservedPath) return `快照包含回滚状态文件: ${path}`
    if (!path || trackedPaths.has(path)) continue
    try {
      lstatSync(join(cwd, path))
      return `快照路径与未跟踪文件冲突: ${path}`
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `检查未跟踪文件失败: ${(e as Error).message}`
    }
  }
  return null
}

function postStageChange(cwd: string, snapshotOid: string): string | null {
  const staged = git(['diff', '--cached', '--quiet', '--no-ext-diff', snapshotOid], cwd)
  if (staged.code === 1) return '暂存区有 stage 之后的新改动'
  if (staged.code !== 0) return `检查暂存区失败: ${staged.out.slice(0, 200)}`
  const worktree = git(['diff', '--quiet', '--no-ext-diff'], cwd)
  if (worktree.code === 1) return '工作区有 stage 之后的新改动'
  if (worktree.code !== 0) return `检查工作区失败: ${worktree.out.slice(0, 200)}`
  return null
}

interface RollbackState {
  tag: string
  anchor: string
  hasPatch?: boolean
  backupOid?: string
  backupRef?: string
  snapshotOid?: string
  stageComplete?: boolean
}

export const snapshotTool: Tool = {
  name: 'snapshot',
  description:
    '把当前工作区状态存为快照(git commit + tag snap-<ts>)。label=备注(可选)。快照后可用 rollback 回滚到该状态。关键修改前调用,改错能回头。',
  parameters: {
    type: 'object',
    properties: { label: { type: 'string', description: '快照备注(可选)' } },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal?.aborted) return { success: false, output: '', error: '快照已取消' }
    const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : 'snapshot'
    const tag = `snap-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '')}`
    const add = git(['add', '-A'], ctx.cwd)
    if (add.code !== 0) return { success: false, output: '', error: `git add 失败: ${add.out.slice(0, 200)}` }
    const commit = git(['commit', '-m', `snap: ${label}`, '--allow-empty'], ctx.cwd)
    if (commit.code !== 0) return { success: false, output: '', error: `git commit 失败: ${commit.out.slice(0, 200)}(非 git 仓库?)` }
    const head = git(['rev-parse', '--verify', 'HEAD'], ctx.cwd)
    const commitOid = head.out.trim()
    if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commitOid)) {
      return { success: false, output: '', error: `快照提交已创建，HEAD 已更新，但无法确认提交 ID: ${head.out.slice(0, 200)}` }
    }
    const tagRes = git(['tag', tag, commitOid], ctx.cwd)
    if (tagRes.code !== 0) {
      return { success: false, output: '', error: `快照提交 ${commitOid} 已创建，HEAD 已更新，但标签 ${tag} 创建失败: ${tagRes.out.slice(0, 200)}` }
    }
    return { success: true, output: `✅ 快照 ${tag}(${label}) 已保存\n回滚: /rollback ${tag} stage` }
  },
}

export const rollbackTool: Tool = {
  name: 'rollback',
  description:
    '回滚到快照(三阶段): stage=恢复快照并备份当前暂存及未暂存改动; clear=取消回滚并恢复原状态; commit=确认回滚。tag=快照名(如 snap-xxx)。',
  parameters: {
    type: 'object',
    properties: {
      tag: { type: 'string', description: '快照名(如 snap-xxx)' },
      action: { type: 'string', description: 'stage / clear / commit' },
    },
    required: ['tag', 'action'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal?.aborted) return { success: false, output: '', error: '回滚已取消' }
    const tag = String(args.tag ?? '')
    const action = String(args.action ?? '')
    if (!tag) return { success: false, output: '', error: '缺少参数 tag' }
    if (!['stage', 'clear', 'commit'].includes(action)) {
      return { success: false, output: '', error: 'action 必须是 stage / clear / commit' }
    }
    const stateFile = rollbackStateFile(ctx.cwd)
    const patchFile = projectStatePath(ctx.cwd, 'rollback.patch')

    if (action === 'stage') {
      if (existsSync(stateFile)) return { success: false, output: '', error: '已有进行中的回滚，请先 clear 或 commit' }
      const head = git(['rev-parse', 'HEAD'], ctx.cwd)
      if (head.code !== 0) return { success: false, output: '', error: `非 git 仓库: ${head.out.slice(0, 100)}` }
      const snapshot = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], ctx.cwd)
      if (snapshot.code !== 0) return { success: false, output: '', error: `快照不存在: ${tag}` }
      const conflict = checkoutConflict(ctx.cwd, snapshot.out.trim(), relative(ctx.cwd, stateFile).replaceAll('\\', '/'))
      if (conflict) return { success: false, output: '', error: conflict }
      if (git(['ls-files', '--error-unmatch', '--', relative(ctx.cwd, stateFile)], ctx.cwd).code === 0) {
        return { success: false, output: '', error: `回滚状态文件已被 Git 跟踪: ${stateFile}` }
      }
      const backup = git(['stash', 'create', 'meicode rollback backup'], ctx.cwd)
      if (backup.code !== 0) return { success: false, output: '', error: `备份当前改动失败: ${backup.out.slice(0, 200)}` }
      const backupOid = backup.out.trim() || undefined
      const backupRef = backupOid ? `refs/meicode/rollback/${randomUUID().replaceAll('-', '')}` : undefined
      if (backupOid && backupRef) {
        const pinned = git(['update-ref', backupRef, backupOid], ctx.cwd)
        if (pinned.code !== 0) return { success: false, output: '', error: `保存回滚备份失败: ${pinned.out.slice(0, 200)}` }
      }
      const state: RollbackState = { tag, anchor: head.out.trim(), backupOid, backupRef, snapshotOid: snapshot.out.trim(), stageComplete: false }
      try {
        mkdirSync(projectStateRoot(ctx.cwd), { recursive: true })
        writeFileSync(stateFile, JSON.stringify(state), 'utf8')
      } catch (e) {
        if (backupRef) git(['update-ref', '-d', backupRef], ctx.cwd)
        return { success: false, output: '', error: `保存回滚状态失败: ${(e as Error).message}` }
      }
      const restore = git(['restore', `--source=${snapshot.out.trim()}`, '--staged', '--worktree', '--', '.'], ctx.cwd)
      if (restore.code !== 0) return { success: false, output: '', error: `恢复快照失败: ${restore.out.slice(0, 200)}；原始改动已备份，可用 clear 恢复` }
      state.stageComplete = true
      try {
        writeFileSync(stateFile, JSON.stringify(state), 'utf8')
      } catch (e) {
        return { success: false, output: '', error: `快照已恢复但更新回滚状态失败: ${(e as Error).message}；原始改动已备份` }
      }
      return {
        success: true,
        output: `⚠️ 已回滚到 ${tag}(文件已恢复)\n原始暂存和未暂存改动已备份\n- 确认: /rollback ${tag} commit\n- 取消: /rollback ${tag} clear`,
      }
    }

    let state: RollbackState | null = null
    try {
      if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8')) as RollbackState
    } catch (e) {
      return { success: false, output: '', error: `读取回滚状态失败: ${(e as Error).message}` }
    }
    if (!state) return { success: false, output: '', error: '没有进行中的回滚(stage 过吗?)' }
    if (state.tag !== tag) return { success: false, output: '', error: `当前回滚快照是 ${state.tag}，不是 ${tag}` }

    if (action === 'clear') {
      const head = git(['rev-parse', 'HEAD'], ctx.cwd)
      if (head.code !== 0 || head.out.trim() !== state.anchor) {
        return { success: false, output: '', error: '当前 HEAD 已变化，无法安全取消回滚' }
      }
      if (state.stageComplete && state.snapshotOid) {
        const changed = postStageChange(ctx.cwd, state.snapshotOid)
        if (changed) return { success: false, output: '', error: `${changed}；请先保存或撤销这些改动，回滚状态和备份仍保留` }
      }
      const conflict = checkoutConflict(ctx.cwd, state.anchor)
      if (conflict) return { success: false, output: '', error: conflict }
      const reset = git(['reset', '--hard', state.anchor], ctx.cwd)
      if (reset.code !== 0) return { success: false, output: '', error: `恢复原提交失败: ${reset.out.slice(0, 200)}` }
      if (state.backupOid) {
        const apply = git(['stash', 'apply', '--index', state.backupOid], ctx.cwd)
        if (apply.code !== 0) return { success: false, output: '', error: `恢复原始改动失败: ${apply.out.slice(0, 200)}；备份仍保留` }
      } else if (state.hasPatch) {
        if (!existsSync(patchFile)) return { success: false, output: '', error: `旧版回滚补丁不存在: ${patchFile}` }
        const apply = git(['apply', patchFile], ctx.cwd)
        if (apply.code !== 0) return { success: false, output: '', error: `恢复旧版补丁失败: ${apply.out.slice(0, 200)}；补丁仍保留` }
      }
      if (state.backupRef) {
        const removed = git(['update-ref', '-d', state.backupRef], ctx.cwd)
        if (removed.code !== 0) return { success: false, output: '', error: `清理备份引用失败: ${removed.out.slice(0, 200)}` }
      }
      rmSync(stateFile, { force: true })
      if (state.hasPatch) rmSync(patchFile, { force: true })
      return { success: true, output: `✅ 已取消回滚,恢复 stage 前状态(锚点 ${state.anchor.slice(0, 8)})` }
    }

    if (action === 'commit') {
      const stateRelative = relative(ctx.cwd, stateFile).replaceAll('\\', '/')
      const patchRelative = relative(ctx.cwd, patchFile).replaceAll('\\', '/')
      const add = git(['add', '-A', '--', '.', `:(exclude)${stateRelative}`, `:(exclude)${patchRelative}`], ctx.cwd)
      if (add.code !== 0) return { success: false, output: '', error: `回滚暂存失败: ${add.out.slice(0, 200)}` }
      const commit = git(['commit', '-m', `rollback: ${tag}`, '--allow-empty'], ctx.cwd)
      if (commit.code !== 0) return { success: false, output: '', error: `回滚提交失败: ${commit.out.slice(0, 200)}` }
      if (state.backupRef) {
        const removed = git(['update-ref', '-d', state.backupRef], ctx.cwd)
        if (removed.code !== 0) return { success: false, output: '', error: `回滚已提交但清理备份引用失败: ${removed.out.slice(0, 200)}` }
      }
      rmSync(stateFile, { force: true })
      if (state.hasPatch) rmSync(patchFile, { force: true })
      return { success: true, output: `✅ 回滚已确认(提交到 ${tag} 的状态)，备份已清理` }
    }

    return { success: false, output: '', error: '未知 action' }
  },
}
