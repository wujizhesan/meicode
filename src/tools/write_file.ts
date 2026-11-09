import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, isAbsolute, dirname, basename } from 'node:path'
import { guardPath } from './types.ts'
import { writeTextAtomic } from './atomic-write.ts'
import { unifiedDiff } from './diff.ts'
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
    if (ctx.signal?.aborted) return { success: false, output: '', error: '写入已取消' }

    const target = isAbsolute(path) ? path : join(ctx.cwd, path)
    const blocked = guardPath(ctx, target)
    if (blocked) return { success: false, output: '', error: blocked }
    try {
      await mkdir(dirname(target), { recursive: true })
      if (ctx.signal?.aborted) return { success: false, output: '', error: '写入已取消' }
      const parent = realpathSync.native(dirname(target))
      const candidate = join(parent, basename(target))
      let exists = false
      try {
        lstatSync(candidate)
        exists = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      const destination = exists ? realpathSync.native(candidate) : candidate
      const blockedAfterMkdir = guardPath(ctx, destination)
      if (blockedAfterMkdir) return { success: false, output: '', error: blockedAfterMkdir }
      if (ctx.signal?.aborted) return { success: false, output: '', error: '写入已取消' }
      // 覆盖写时留一份旧内容用于 diff；新文件或读不了（二进制/权限）就当作空文件
      let previous = ''
      if (exists) {
        try {
          previous = readFileSync(destination, 'utf8')
        } catch {
          previous = ''
        }
      }
      await writeTextAtomic(destination, content, ctx)
      const diff = unifiedDiff(previous, content)
      return { success: true, output: `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`, evidence: { files: [target], changedFiles: [target] }, ...(diff ? { diff } : {}) }
    } catch (e) {
      return { success: false, output: '', error: `写入失败: ${(e as Error).message}` }
    }
  },
}
