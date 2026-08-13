import { readdir, readFile } from 'node:fs/promises'
import { join, isAbsolute, relative, extname } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_LINES = 200
const MAX_PER_FILE = 20
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt'])
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf'])

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      await collectFiles(p, out)
    } else if (e.isFile() && !BINARY_EXT.has(extname(e.name).toLowerCase())) {
      out.push(p)
    }
  }
}

export const grepCodeTool: Tool = {
  name: 'grep_code',
  description: '用正则表达式在代码文件中搜索内容，返回 文件:行号: 匹配行。自动排除 node_modules 与二进制文件。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（如 import .*from）' },
      path: { type: 'string', description: '搜索起始目录（可选，默认当前工作目录）' },
    },
    required: ['pattern'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string
    if (!pattern) return { success: false, output: '', error: '缺少参数 pattern' }
    const base = typeof args.path === 'string' && args.path ? (isAbsolute(args.path) ? args.path : join(ctx.cwd, args.path)) : ctx.cwd

    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return { success: false, output: '', error: `非法正则: ${(e as Error).message}` }
    }

    const files: string[] = []
    await collectFiles(base, files)

    const lines: string[] = []
    let truncated = false
    for (const file of files) {
      if (lines.length >= MAX_LINES) {
        truncated = true
        break
      }
      let content: string
      try {
        content = await readFile(file, 'utf8')
      } catch {
        continue
      }
      let hits = 0
      const fileLines = content.split('\n')
      for (let i = 0; i < fileLines.length; i++) {
        if (re.test(fileLines[i])) {
          lines.push(`${relative(base, file)}:${i + 1}: ${fileLines[i].slice(0, 200)}`)
          hits++
          if (hits >= MAX_PER_FILE) break
          if (lines.length >= MAX_LINES) {
            truncated = true
            break
          }
        }
      }
    }

    const out = lines.length === 0 ? '未找到匹配内容' : lines.join('\n')
    return { success: true, output: out + (truncated ? '\n…[结果过多已截断]' : ''), truncated }
  },
}
