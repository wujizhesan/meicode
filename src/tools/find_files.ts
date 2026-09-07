import { readdir } from 'node:fs/promises'
import { join, isAbsolute, relative } from 'node:path'
import { minimatch } from 'minimatch'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_RESULTS = 100

async function* walkFiles(dir: string, base: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = relative(base, fullPath).replaceAll('\\', '/')
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, base)
    } else if (entry.isFile()) {
      yield relPath
    }
  }
}

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
      for await (const entry of walkFiles(base, base)) {
        if (!minimatch(entry, pattern)) continue
        results.push(entry)
        if (results.length >= MAX_RESULTS) break
      }
    } catch (e) {
      return { success: false, output: '', error: `查找失败: ${(e as Error).message}` }
    }

    results.sort()
    const truncated = results.length >= MAX_RESULTS
    const listed = truncated ? results.slice(0, MAX_RESULTS - 1) : results
    const out = listed.length === 0 ? '未找到匹配文件' : listed.join('\n')
    return { success: true, output: out + (truncated ? `\n…[仅显示前 ${MAX_RESULTS - 1} 条]` : ''), truncated }
  },
}
