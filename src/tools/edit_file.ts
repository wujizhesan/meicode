import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { withFileLock } from '../runtime/file-lock.ts'
import { writeTextAtomicSync } from './atomic-write.ts'
import { guardPath, truncateOutput } from './types.ts'
import { unifiedDiff } from './diff.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '用原文唯一匹配替换修改文件内容。old_text 必须在文件中恰好出现一次，否则报错。用于精确修改而不覆盖整个文件。编辑前必须先读取该文件；匹配失败时根据错误信息调整上下文后重试。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要修改的文件路径（相对或绝对）' },
      old_text: { type: 'string', description: '要替换的原文片段（必须在文件中唯一出现）' },
      new_text: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_text', 'new_text'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = args.path as string
    const oldText = args.old_text as string
    const newText = args.new_text as string
    if (!path || typeof oldText !== 'string' || oldText.length === 0 || typeof newText !== 'string') {
      return { success: false, output: '', error: '缺少参数 path / old_text / new_text' }
    }
    if (ctx.signal?.aborted) return { success: false, output: '', error: '编辑已取消' }

    const target = isAbsolute(path) ? path : join(ctx.cwd, path)
    const blocked = guardPath(ctx, target)
    if (blocked) return { success: false, output: '', error: blocked }
    let canonical: string
    try {
      canonical = realpathSync.native(target)
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }
    const blockedCanonical = guardPath(ctx, canonical)
    if (blockedCanonical) return { success: false, output: '', error: blockedCanonical }
    const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const lockFile = join(tmpdir(), 'meicode-edit-locks', `${createHash('sha256').update(normalized).digest('hex')}.lock`)
    try {
      return withFileLock(lockFile, () => {
        let content: string
        try {
          content = readFileSync(canonical, 'utf8')
        } catch (e) {
          return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
        }

        const firstPos = content.indexOf(oldText)
        if (firstPos < 0) {
          return { success: false, output: '', error: '未找到原文片段（检查转义、换行与实际文件内容）' }
        }
        if (content.indexOf(oldText, firstPos + 1) >= 0) {
          return {
            success: false,
            output: '',
            error: `原文匹配到多处（首个匹配位置在第 ${firstPos} 个字符），请提供更长、更唯一的上下文`,
          }
        }

        const updated = content.slice(0, firstPos) + newText + content.slice(firstPos + oldText.length)
        if (ctx.signal?.aborted) return { success: false, output: '', error: '编辑已取消' }
        try {
          writeTextAtomicSync(canonical, updated, ctx)
          const summary = `已替换 1 处\n--- 旧 ---\n${oldText}\n--- 新 ---\n${newText}`
          const { output, truncated } = truncateOutput(summary)
          const diff = unifiedDiff(content, updated)
          return { success: true, output, truncated, evidence: { files: [target], changedFiles: [target] }, ...(diff ? { diff } : {}) }
        } catch (e) {
          return { success: false, output: '', error: `写入失败: ${(e as Error).message}` }
        }
      })
    } catch (e) {
      return { success: false, output: '', error: `编辑锁失败: ${(e as Error).message}` }
    }
  },
}
