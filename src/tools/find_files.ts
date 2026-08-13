import { glob } from 'node:fs/promises'
import { join, isAbsolute, relative } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_RESULTS = 100

export const findFilesTool: Tool = {
  name: 'find_files',
  description: '按 glob 模式在目录中查找文件（如 **/*.ts、*.yaml）。自动排除 node_modules 与 .git。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
      path: { type: 'string', description: '搜索起始目录（可选，默认当前工作目录）' },
    },
    required: ['pattern'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string
    if (!pattern) return { success: false, output: '', error: '缺少参数 pattern' }
    const base = typeof args.path === 'string' && args.path ? (isAbsolute(args.path) ? args.path : join(ctx.cwd, args.path)) : ctx.cwd

    const results: string[] = []
    try {
      const iter = glob(pattern, { cwd: base })
      for await (const entry of iter) {
        const p = String(entry)
        if (p.includes('node_modules') || p.includes('.git')) continue
        results.push(p)
        if (results.length >= MAX_RESULTS) break
      }
    } catch (e) {
      return { success: false, output: '', error: `查找失败: ${(e as Error).message}` }
    }

    results.sort()
    const truncated = results.length >= MAX_RESULTS
    const listed = truncated ? results.slice(0, MAX_RESULTS - 1) : results
    const out = listed.length === 0 ? '未找到匹配文件' : listed.map((p) => relative(base, join(base, p))).join('\n')
    return { success: true, output: out + (truncated ? `\n…[仅显示前 ${MAX_RESULTS - 1} 条]` : ''), truncated }
  },
}
