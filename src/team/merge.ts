import { spawn } from 'node:child_process'
import type { WorktreeManager } from '../worktree/index.ts'
import type { TeamGroup } from './types.ts'

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

export async function mergeTeamWorktrees(
  group: TeamGroup,
  worktrees: WorktreeManager | null,
  repoRoot: string,
): Promise<string> {
  const results: string[] = []
  for (const member of group.members) {
    if (!worktrees) {
      results.push(`成员 ${member.name} 无 worktree 支持，跳过`)
      continue
    }
    const worktreeName = `member-${member.name}`
    try {
      const info = await worktrees.exit(worktreeName)
      if (!info.dirty) {
        results.push(`成员 ${member.name} 无变更，跳过`)
        continue
      }
      const add = await git(['-C', info.path, 'add', '-A'])
      const commit = await git(['-C', info.path, 'commit', '-m', `team: ${member.name} changes`])
      if (add.code !== 0 || commit.code !== 0) {
        results.push(`✗ 成员 ${member.name} commit 失败: ${add.out || commit.out}`.slice(0, 150))
        continue
      }
      const merged = await git(['merge', `wt-${worktreeName}`], repoRoot)
      if (merged.code === 0) {
        results.push(`✓ 合并 ${member.name} 成功`)
        continue
      }
      const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], repoRoot)
      await git(['merge', '--abort'], repoRoot)
      results.push(
        `✗ 合并 ${member.name} 冲突，已回滚（worktree ${worktreeName} 保留待处理）\n  冲突文件: ${conflicts.out.trim() || '(未检测到)'}`,
      )
    } catch (error) {
      results.push(`✗ 成员 ${member.name} 合并失败: ${(error as Error).message}`)
    }
  }
  return results.join('\n')
}
