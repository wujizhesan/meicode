import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 快照/回滚工具(对齐 opencode git 快照 + 三阶段 revert):
// snapshot  = 当前工作区状态存为 git commit + tag(snap-<ts>)
// rollback  = 三阶段: stage(恢复文件到快照,当前修改存 patch 可找回)
//             → clear(取消回滚,恢复 stage 前状态) → commit(确认回滚)
// 安全网: 改错文件可以回头,不手动恢复

// execFileSync 不经 shell——参数含空格/中文不被分词(commit message 会含空格)
function git(args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { code: err.status ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

function rollbackStateFile(cwd: string): string {
  return join(cwd, '.mewcode', 'rollback-state.json')
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
    const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : 'snapshot'
    const tag = `snap-${Date.now().toString(36)}`
    const add = git(['add', '-A'], ctx.cwd)
    if (add.code !== 0) return { success: false, output: '', error: `git add 失败: ${add.out.slice(0, 200)}` }
    const commit = git(['commit', '-m', `snap: ${label}`, '--allow-empty'], ctx.cwd)
    if (commit.code !== 0) return { success: false, output: '', error: `git commit 失败: ${commit.out.slice(0, 200)}(非 git 仓库?)` }
    const tagRes = git(['tag', tag], ctx.cwd)
    if (tagRes.code !== 0) return { success: false, output: '', error: `git tag 失败: ${tagRes.out.slice(0, 200)}` }
    return { success: true, output: `✅ 快照 ${tag}(${label}) 已保存\n回滚: /rollback ${tag} stage` }
  },
}

export const rollbackTool: Tool = {
  name: 'rollback',
  description:
    '回滚到快照(三阶段): stage=恢复文件到快照状态(当前未提交修改存 .mewcode/rollback.patch 可找回); clear=取消回滚(恢复 stage 前状态); commit=确认回滚。tag=快照名(如 snap-xxx)。',
  parameters: {
    type: 'object',
    properties: {
      tag: { type: 'string', description: '快照名(如 snap-xxx)' },
      action: { type: 'string', description: 'stage / clear / commit' },
    },
    required: ['tag', 'action'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tag = String(args.tag ?? '')
    const action = String(args.action ?? '')
    if (!tag) return { success: false, output: '', error: '缺少参数 tag' }
    if (!['stage', 'clear', 'commit'].includes(action)) {
      return { success: false, output: '', error: 'action 必须是 stage / clear / commit' }
    }
    const stateFile = rollbackStateFile(ctx.cwd)
    const patchFile = join(ctx.cwd, '.mewcode', 'rollback.patch')
    mkdirSync(join(ctx.cwd, '.mewcode'), { recursive: true })

    if (action === 'stage') {
      // 锚点 = 当前 HEAD;未提交修改存 patch(可找回);恢复文件到快照
      const head = git(['rev-parse', 'HEAD'], ctx.cwd)
      if (head.code !== 0) return { success: false, output: '', error: `非 git 仓库: ${head.out.slice(0, 100)}` }
      const diff = git(['diff'], ctx.cwd)
      const exists = existsSync(patchFile)
      const state = { tag, anchor: head.out.trim(), hasPatch: diff.out.length > 0 || exists }
      if (diff.out.length > 0) writeFileSync(patchFile, diff.out, 'utf8')
      const restore = git(['checkout', tag, '--', '.'], ctx.cwd)
      if (restore.code !== 0) return { success: false, output: '', error: `恢复快照失败(快照存在?): ${restore.out.slice(0, 200)}` }
      writeFileSync(stateFile, JSON.stringify(state), 'utf8')
      return {
        success: true,
        output: `⚠️ 已回滚到 ${tag}(文件已恢复)\n当前未提交修改已存 ${patchFile}\n- 确认: /rollback ${tag} commit\n- 取消: /rollback ${tag} clear`,
      }
    }

    const state = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { tag: string; anchor: string; hasPatch: boolean }) : null

    if (action === 'clear') {
      if (!state) return { success: false, output: '', error: '没有进行中的回滚(stage 过吗?)' }
      // 取消:从锚点恢复文件 + 应用 patch 找回未提交修改
      git(['checkout', state.anchor, '--', '.'], ctx.cwd)
      if (state.hasPatch && existsSync(patchFile)) git(['apply', patchFile], ctx.cwd)
      rmSync(stateFile, { force: true })
      return { success: true, output: `✅ 已取消回滚,恢复 stage 前状态(锚点 ${state.anchor.slice(0, 8)})` }
    }

    if (action === 'commit') {
      if (!state) return { success: false, output: '', error: '没有进行中的回滚(stage 过吗?)' }
      const add = git(['add', '-A'], ctx.cwd)
      const commit = git(['commit', '-m', `rollback: ${tag}`, '--allow-empty'], ctx.cwd)
      if (add.code !== 0 || commit.code !== 0) {
        return { success: false, output: '', error: `回滚提交失败: ${add.out || commit.out}`.slice(0, 200) }
      }
      rmSync(stateFile, { force: true })
      rmSync(patchFile, { force: true })
      return { success: true, output: `✅ 回滚已确认(提交到 ${tag} 的状态),patch 已清理` }
    }

    return { success: false, output: '', error: '未知 action' }
  },
}
