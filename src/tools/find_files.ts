import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'
import { Minimatch } from 'minimatch'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_RESULTS = 100
const READ_CONCURRENCY = 16

type DirectoryRead = { entries: Dirent[] } | { error: unknown }

interface PendingRead {
  dir: string
  resolve: (result: DirectoryRead) => void
}

class ReaddirPool {
  private active = 0
  private cancelled = false
  private readonly queue: PendingRead[] = []

  read(dir: string): Promise<DirectoryRead> {
    return new Promise((resolve) => {
      if (this.cancelled) {
        resolve({ error: new Error('directory read cancelled') })
        return
      }
      this.queue.push({ dir, resolve })
      this.pump()
    })
  }

  cancel(): void {
    this.cancelled = true
    for (const pending of this.queue.splice(0)) pending.resolve({ error: new Error('directory read cancelled') })
  }

  private pump(): void {
    while (!this.cancelled && this.active < READ_CONCURRENCY && this.queue.length > 0) {
      const pending = this.queue.shift()!
      this.active++
      void readdir(pending.dir, { withFileTypes: true })
        .then(
          (entries) => pending.resolve({ entries }),
          (error: unknown) => pending.resolve({ error }),
        )
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}

async function* walkFiles(
  dir: string,
  base: string,
  pool: ReaddirPool,
  load: Promise<DirectoryRead> = pool.read(dir),
): AsyncGenerator<string> {
  const result = await load
  if ('error' in result) throw result.error
  const entries = result.entries
  const childReads = new Map<number, Promise<DirectoryRead>>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      childReads.set(i, pool.read(join(dir, entry.name)))
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const fullPath = join(dir, entry.name)
    const relPath = relative(base, fullPath).replaceAll('\\', '/')
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, base, pool, childReads.get(i)!)
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
    const pool = new ReaddirPool()
    try {
      const matcher = new Minimatch(pattern)
      for await (const entry of walkFiles(base, base, pool)) {
        if (!matcher.match(entry)) continue
        results.push(entry)
        if (results.length >= MAX_RESULTS) break
      }
    } catch (e) {
      return { success: false, output: '', error: `查找失败: ${(e as Error).message}` }
    } finally {
      pool.cancel()
    }

    results.sort()
    const truncated = results.length >= MAX_RESULTS
    const listed = truncated ? results.slice(0, MAX_RESULTS - 1) : results
    const out = listed.length === 0 ? '未找到匹配文件' : listed.join('\n')
    return { success: true, output: out + (truncated ? `\n…[仅显示前 ${MAX_RESULTS - 1} 条]` : ''), truncated }
  },
}
