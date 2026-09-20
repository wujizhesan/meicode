import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, isAbsolute, relative, extname } from 'node:path'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_LINES = 200
const MAX_PER_FILE = 20
const READ_CONCURRENCY = 16
const MAX_LINE_PREFIX_BYTES = 800
const REGEXP_META = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '\r', '\n'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt'])
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.jar', '.docx', '.xlsx', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class',
  '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.woff', '.woff2', '.ttf',
])

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

async function* walkTextFiles(
  dir: string,
  pool: ReaddirPool,
  load: Promise<DirectoryRead> = pool.read(dir),
): AsyncGenerator<string> {
  const result = await load
  if ('error' in result) return
  const entries = result.entries
  const childReads = new Map<number, Promise<DirectoryRead>>()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
      childReads.set(index, pool.read(join(dir, entry.name)))
    }
  }
  for (let index = 0; index < entries.length; index++) {
    const e = entries[index]
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      yield* walkTextFiles(p, pool, childReads.get(index)!)
    } else if (e.isFile() && !BINARY_EXT.has(extname(e.name).toLowerCase())) {
      yield p
    }
  }
}

function isLiteralPattern(pattern: string): boolean {
  for (const char of pattern) if (REGEXP_META.has(char)) return false
  return true
}

function searchRegexContent(content: string, relFile: string, re: RegExp): string[] {
  const matches: string[] = []
  let lineNumber = 1
  let lineStart = 0
  while (lineStart <= content.length) {
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? content.length : newline
    const line = content.slice(lineStart, lineEnd)
    if (re.test(line)) {
      matches.push(`${relFile}:${lineNumber}: ${line.slice(0, 200)}`)
      if (matches.length >= MAX_PER_FILE) break
    }
    if (newline < 0) break
    lineStart = newline + 1
    lineNumber++
  }
  return matches
}

function searchLiteralBytes(bytes: Buffer, relFile: string, literal: string): string[] {
  const matches: string[] = []
  const needle = Buffer.from(literal)
  let cursor = 0
  let lineStart = 0
  let lineNumber = 1
  while (cursor <= bytes.length) {
    const match = bytes.indexOf(needle, cursor)
    if (match < 0) break
    while (cursor < match) {
      if (bytes[cursor] === 10) {
        lineNumber++
        lineStart = cursor + 1
      }
      cursor++
    }
    const newline = bytes.indexOf(10, match)
    const lineEnd = newline < 0 ? bytes.length : newline
    const prefixEnd = Math.min(lineEnd, lineStart + MAX_LINE_PREFIX_BYTES)
    matches.push(`${relFile}:${lineNumber}: ${bytes.subarray(lineStart, prefixEnd).toString('utf8').slice(0, 200)}`)
    if (matches.length >= MAX_PER_FILE || newline < 0) break
    cursor = newline + 1
    lineStart = cursor
    lineNumber++
  }
  return matches
}

async function searchFile(file: string, base: string, re: RegExp, literal: string | undefined): Promise<string[]> {
  const relFile = relative(base, file)
  if (literal !== undefined) {
    try {
      return searchLiteralBytes(await readFile(file), relFile, literal)
    } catch {
      return []
    }
  }
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch {
    return []
  }
  return searchRegexContent(content, relFile, re)
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

    const literal = isLiteralPattern(pattern) ? pattern : undefined
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return { success: false, output: '', error: `非法正则: ${(e as Error).message}` }
    }
    const lines: string[] = []
    let truncated = false
    let stopped = false
    const pool = new ReaddirPool()
    const pending: string[] = []
    const flush = async (): Promise<boolean> => {
      const batches = await Promise.all(pending.map((file) => searchFile(file, base, re, literal)))
      pending.length = 0
      for (const matches of batches) {
        for (const match of matches) {
          lines.push(match)
          if (lines.length >= MAX_LINES) {
            truncated = true
            return true
          }
        }
      }
      return false
    }
    try {
      for await (const file of walkTextFiles(base, pool)) {
        pending.push(file)
        if (pending.length >= READ_CONCURRENCY && await flush()) {
          stopped = true
          break
        }
      }
    } finally {
      pool.cancel()
    }
    if (!stopped && pending.length > 0) await flush()

    const out = lines.length === 0 ? '未找到匹配内容' : lines.join('\n')
    return { success: true, output: out + (truncated ? '\n…[结果过多已截断]' : ''), truncated }
  },
}
