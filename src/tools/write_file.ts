import { writeFile, mkdir } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { guardPath } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入文本内容到指定路径（覆盖已存在文件）。父目录不存在时自动创建。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径（相对或绝对）' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = args.path as string
    const content = args.content as string
    if (!path) return { success: false, output: '', error: '缺少参数 path' }
    if (typeof content !== 'string') return { success: false, output: '', error: '缺少参数 content' }

    const target = isAbsolute(path) ? path : join(ctx.cwd, path)
    const blocked = guardPath(ctx, target)
    if (blocked) return { success: false, output: '', error: blocked }
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return { success: true, output: `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`, evidence: { files: [target], changedFiles: [target] } }
    } catch (e) {
      return { success: false, output: '', error: `写入失败: ${(e as Error).message}` }
    }
  },
}
