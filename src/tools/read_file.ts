import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { truncateOutput } from './types.ts'

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取指定路径的文本文件内容。路径相对当前工作目录，也支持绝对路径。不受工作目录限制——读取工作目录外的目标（如全局 npm 包 D:/tmpnpm-global、其他盘项目）请用本工具而非 run_command。编辑或修改文件前必须先读取该文件确认上下文。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径（相对或绝对）' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = args.path as string
    if (!path) return { success: false, output: '', error: '缺少参数 path' }

    const target = isAbsolute(path) ? path : join(ctx.cwd, path)
    try {
      const content = await readFile(target, 'utf8')
      const { output, truncated } = truncateOutput(content)
      return { success: true, output, truncated }
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }
  },
}
