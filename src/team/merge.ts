import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { WorktreeManager } from '../worktree/index.ts'
import type { TeamGroup } from './types.ts'

export interface TeamMergeResult {
  success: boolean
  output: string
}

function git(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false })
    let out = ''
    child.stdout?.on('data', (data: Buffer) => (out += data.toString()))
    child.stderr?.on('data', (data: Buffer) => (out += data.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
    child.on('error', () => resolve({ code: -1, out }))
  })
}

function failed(output: string): TeamMergeResult {
  return { success: false, output }
}

export async function mergeTeamWorktrees(
  group: TeamGroup,
  worktrees: WorktreeManager | null,
  repoRoot: string,
): Promise<TeamMergeResult> {
  if (!worktrees) {
    return {
      success: true,
      output: group.members.map((member) => `成员 ${member.name} 无 worktree 支持，跳过`).join('\n'),
    }
  }

  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot)
  if (branch.code !== 0 || !branch.out.trim()) return failed('拒绝合并：主仓库当前处于 detached HEAD')
  const status = await git(['status', '--porcelain'], repoRoot)
  if (status.code !== 0) return failed(`拒绝合并：无法检查主仓库状态: ${status.out.slice(0, 200)}`)
  if (status.out.trim()) return failed(`拒绝合并：主仓库存在未提交修改\n${status.out.trim().slice(0, 500)}`)
  const initialHead = await git(['rev-parse', '--verify', 'HEAD'], repoRoot)
  if (initialHead.code !== 0 || !initialHead.out.trim()) return failed(`拒绝合并：无法读取主仓库 HEAD: ${initialHead.out.slice(0, 200)}`)
  const startHead = initialHead.out.trim()

  const results: string[] = []
  const prepared: Array<{ memberName: string; branch: string }> = []
  for (const member of group.members) {
    const worktreeName = `member-${member.name}`
    try {
      const info = await worktrees.exit(worktreeName)
      const worktreeStatus = await git(['-C', info.path, 'status', '--porcelain'], repoRoot)
      if (worktreeStatus.code !== 0) return failed(`成员 ${member.name} 状态检查失败: ${worktreeStatus.out.slice(0, 300)}`)
      if (worktreeStatus.out.trim()) {
        const add = await git(['-C', info.path, 'add', '-A'], repoRoot)
        if (add.code !== 0) return failed(`成员 ${member.name} 暂存失败: ${add.out.slice(0, 300)}`)
        const commit = await git([
          '-C', info.path,
          '-c', 'user.name=MeiCode',
          '-c', 'user.email=meicode@local',
          'commit', '-m', `team: ${member.name} changes`,
        ], repoRoot)
        if (commit.code !== 0) return failed(`成员 ${member.name} commit 失败: ${commit.out.slice(0, 300)}`)
      }
      const ahead = await git(['rev-list', '--count', `${startHead}..${info.branch}`], repoRoot)
      if (ahead.code !== 0) return failed(`成员 ${member.name} 分支检查失败: ${ahead.out.slice(0, 300)}`)
      if (Number(ahead.out.trim()) === 0) {
        results.push(`成员 ${member.name} 无变更，跳过`)
        continue
      }
      prepared.push({ memberName: member.name, branch: info.branch })
    } catch (error) {
      return failed(`成员 ${member.name} 合并准备失败: ${(error as Error).message}`)
    }
  }

  if (prepared.length === 0) return { success: true, output: results.join('\n') }

  const tempRoot = mkdtempSync(join(tmpdir(), 'meicode-team-merge-'))
  const integrationPath = join(tempRoot, 'integration')
  let integrationAdded = false
  try {
    const added = await git(['worktree', 'add', '--detach', integrationPath, startHead], repoRoot)
    if (added.code !== 0) return failed(`无法创建合并预演环境: ${added.out.slice(0, 300)}`)
    integrationAdded = true
    for (const item of prepared) {
      const merged = await git([
        '-C', integrationPath,
        '-c', 'user.name=MeiCode',
        '-c', 'user.email=meicode@local',
        'merge', '--no-edit', item.branch,
      ], repoRoot)
      if (merged.code === 0) continue
      const conflicts = await git(['-C', integrationPath, 'diff', '--name-only', '--diff-filter=U'], repoRoot)
      await git(['-C', integrationPath, 'merge', '--abort'], repoRoot)
      return failed(
        `合并 ${item.memberName} 冲突，主仓库未修改（worktree 保留待处理）\n  冲突文件: ${conflicts.out.trim() || '(未检测到)'}`,
      )
    }
    const integrationHead = await git(['-C', integrationPath, 'rev-parse', '--verify', 'HEAD'], repoRoot)
    if (integrationHead.code !== 0 || !integrationHead.out.trim()) return failed(`无法读取合并预演结果: ${integrationHead.out.slice(0, 300)}`)
    const currentHead = await git(['rev-parse', '--verify', 'HEAD'], repoRoot)
    const currentStatus = await git(['status', '--porcelain'], repoRoot)
    if (currentHead.code !== 0 || currentHead.out.trim() !== startHead || currentStatus.code !== 0 || currentStatus.out.trim()) {
      return failed('拒绝应用合并：预演期间主仓库状态已变化')
    }
    const applied = await git(['merge', '--ff-only', integrationHead.out.trim()], repoRoot)
    if (applied.code !== 0) return failed(`应用合并结果失败，主仓库未发生部分合并: ${applied.out.slice(0, 300)}`)
    results.push(...prepared.map((item) => `✓ 合并 ${item.memberName} 成功`))
    return { success: true, output: results.join('\n') }
  } finally {
    let removeFailed = false
    if (integrationAdded) {
      try {
        const removed = await git(['worktree', 'remove', integrationPath, '--force'], repoRoot)
        removeFailed = removed.code !== 0
        if (removeFailed) console.warn(`[团队] 合并预演 worktree 清理失败: ${removed.out.slice(0, 300)}`)
      } catch (error) {
        removeFailed = true
        console.warn(`[团队] 合并预演 worktree 清理异常: ${(error as Error).message}`)
      }
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[团队] 合并预演临时目录清理异常: ${(error as Error).message}`)
    }
    if (removeFailed) {
      try {
        await git(['worktree', 'prune'], repoRoot)
      } catch {
      }
    }
  }
}
