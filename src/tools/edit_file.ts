import { readFile, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { guardPath } from './types.ts'
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
    if (!path || typeof oldText !== 'string' || typeof newText !== 'string') {
      return { success: false, output: '', error: '缺少参数 path / old_text / new_text' }
    }

    const target = isAbsolute(path) ? path : join(ctx.cwd, path)
    const blocked = guardPath(ctx, target)
    if (blocked) return { success: false, output: '', error: blocked }
    let content: string
    try {
      content = await readFile(target, 'utf8')
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }

    const count = content.split(oldText).length - 1
    if (count === 0) {
      return { success: false, output: '', error: '未找到原文片段（检查转义、换行与实际文件内容）' }
    }
    if (count > 1) {
      const firstPos = content.indexOf(oldText)
      return {
        success: false,
        output: '',
        error: `原文匹配到 ${count} 处（首个匹配位置在第 ${firstPos} 个字符），请提供更长、更唯一的上下文`,
      }
    }

    const updated = content.replace(oldText, newText)
    try {
      await writeFile(target, updated, 'utf8')
      const summary = `已替换 1 处\n--- 旧 ---\n${oldText}\n--- 新 ---\n${newText}`
      return { success: true, output: summary, evidence: { files: [target], changedFiles: [target] } }
    } catch (e) {
      return { success: false, output: '', error: `写入失败: ${(e as Error).message}` }
    }
  },
}
