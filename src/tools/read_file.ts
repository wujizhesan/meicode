import { open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { MAX_RESULT_BYTES } from './types.ts'

const truncatedSuffix = (nextOffset: number): string => `\n…[结果已截断；下一页 offset=${nextOffset}]`

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取指定路径的文本文件内容。路径相对当前工作目录，也支持绝对路径。大文件可用返回的下一页 offset（从 0 开始的 UTF-8 字节偏移）继续读取。不受工作目录限制——读取工作目录外的目标（如全局 npm 包 D:/tmpnpm-global、其他盘项目）请用本工具而非 run_command。编辑或修改文件前必须先读取该文件确认上下文。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径（相对或绝对）' },
      offset: { type: 'integer', minimum: 0, description: '从该 UTF-8 字节偏移量开始读取，默认 0；可使用上一页返回的下一页 offset' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = args.path as string
    if (!path) return { success: false, output: '', error: '缺少参数 path' }
    const offset = args.offset ?? 0
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - MAX_RESULT_BYTES) {
      return { success: false, output: '', error: '参数 offset 必须是非负的安全整数 UTF-8 字节偏移量' }
    }
    if (ctx.signal?.aborted) return { success: false, output: '', error: '读取已取消' }

    const target = isAbsolute(path) ? path : join(ctx.cwd, path)
    try {
      const handle = await open(target, 'r')
      const buffer = Buffer.allocUnsafe(MAX_RESULT_BYTES + 1)
      let bytesRead = 0
      try {
        while (bytesRead < buffer.length) {
          if (ctx.signal?.aborted) return { success: false, output: '', error: '读取已取消' }
          const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead)
          if (ctx.signal?.aborted) return { success: false, output: '', error: '读取已取消' }
          if (result.bytesRead === 0) break
          bytesRead += result.bytesRead
        }
      } finally {
        await handle.close()
      }
      if (ctx.signal?.aborted) return { success: false, output: '', error: '读取已取消' }
      if (bytesRead > 0 && (buffer[0] & 0xc0) === 0x80) {
        return { success: false, output: '', error: `offset ${offset} 位于 UTF-8 字符中间` }
      }
      const truncated = bytesRead > MAX_RESULT_BYTES
      let output: string
      if (!truncated) {
        output = buffer.subarray(0, bytesRead).toString('utf8')
      } else {
        const contentLimit = MAX_RESULT_BYTES - Buffer.byteLength(truncatedSuffix(offset + MAX_RESULT_BYTES), 'utf8')
        let end = contentLimit
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
        output = buffer.subarray(0, end).toString('utf8') + truncatedSuffix(offset + end)
      }
      return { success: true, output, truncated, evidence: { files: [target] } }
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }
  },
}
