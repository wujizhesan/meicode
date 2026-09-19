import { open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { MAX_RESULT_BYTES } from './types.ts'

const TRUNCATED_SUFFIX = '\n…[结果已截断]'

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
      const handle = await open(target, 'r')
      const buffer = Buffer.allocUnsafe(MAX_RESULT_BYTES + 1)
      let bytesRead = 0
      try {
        while (bytesRead < buffer.length) {
          const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
          if (result.bytesRead === 0) break
          bytesRead += result.bytesRead
        }
      } finally {
        await handle.close()
      }
      const truncated = bytesRead > MAX_RESULT_BYTES
      let output: string
      if (!truncated) {
        output = buffer.subarray(0, bytesRead).toString('utf8')
      } else {
        const contentLimit = MAX_RESULT_BYTES - Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8')
        let end = contentLimit
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
        output = buffer.subarray(0, end).toString('utf8') + TRUNCATED_SUFFIX
      }
      return { success: true, output, truncated, evidence: { files: [target] } }
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }
  },
}
