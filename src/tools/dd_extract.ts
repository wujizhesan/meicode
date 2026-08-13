import { openSync, readSync, closeSync, writeFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardPath } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 代码分析工具：按字节偏移从大文件切出内嵌内容（bundle 提取，Node fs 实现不依赖 dd）
// 用法：dd_extract path=<文件> skip=<起始偏移字节> count=<长度字节> out=<输出路径>
export const ddExtractTool: Tool = {
  name: 'dd_extract',
  description:
    '按字节偏移从大文件切出内嵌内容（提取内嵌 JS bundle）。path=源文件 skip=起始偏移(字节) count=截取长度(字节,默认到文件尾) out=输出路径。返回文件头/尾特征字节用于验证。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '源文件路径' },
      skip: { type: 'number', description: '起始偏移（字节）' },
      count: { type: 'number', description: '截取长度（字节，默认到文件尾）' },
      out: { type: 'string', description: '输出文件路径' },
    },
    required: ['path', 'skip', 'out'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args.path ?? '')
    if (!rawPath) return { success: false, output: '', error: '缺少参数 path' }
    const target = resolve(ctx.cwd, rawPath)
    const blocked = guardPath(ctx, target, false) // 输入纯读:外部目标可读(核心需求)
    if (blocked) return { success: false, output: '', error: blocked }
    const skip = typeof args.skip === 'number' ? Math.max(0, Math.floor(args.skip)) : 0
    const outPath = resolve(ctx.cwd, String(args.out ?? ''))
    const outBlocked = guardPath(ctx, outPath) // 产物是写路径:必须围栏(防写绕过)
    if (outBlocked) return { success: false, output: '', error: outBlocked }

    let size: number
    try {
      size = statSync(target).size
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }
    if (skip >= size) return { success: false, output: '', error: `skip(${skip}) 超出文件大小(${size})` }
    const count = typeof args.count === 'number' ? Math.min(Math.max(0, Math.floor(args.count)), size - skip) : size - skip
    if (count === 0) return { success: false, output: '', error: 'count 为 0' }

    try {
      const fd = openSync(target, 'r')
      const buf = Buffer.alloc(count)
      let read = 0
      while (read < count) {
        const n = readSync(fd, buf, read, count - read, skip + read)
        if (n <= 0) break
        read += n
      }
      closeSync(fd)
      writeFileSync(outPath, buf.subarray(0, read))
      // 特征预览:头 32 字节 + 尾 32 字节(hex+ascii)
      const head = buf.subarray(0, Math.min(32, read))
      const tail = buf.subarray(Math.max(0, read - 32), read)
      const fmt = (b: Buffer) =>
        `hex: ${b.toString('hex').slice(0, 64)}\nascii: ${b.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`
      return {
        success: true,
        output: `已提取 ${read} 字节 (skip=${skip}, 请求 ${count})\n→ ${outPath}\n头: ${fmt(head)}\n尾: ${fmt(tail)}`,
      }
    } catch (e) {
      return { success: false, output: '', error: `提取失败: ${(e as Error).message}` }
    }
  },
}
