import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, isAbsolute, relative, extname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const MAX_LINES = 200
const MAX_PER_FILE = 20
const READ_CONCURRENCY = 16
const REGEXP_META = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '\r', '\n'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt'])
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.jar', '.docx', '.xlsx', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class',
  '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.woff', '.woff2', '.ttf',
])

async function* walkTextFiles(dir: string): AsyncGenerator<string> {
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
      yield* walkTextFiles(p)
    } else if (e.isFile() && !BINARY_EXT.has(extname(e.name).toLowerCase())) {
      yield p
    }
  }
}

function isLiteralPattern(pattern: string): boolean {
  for (const char of pattern) if (REGEXP_META.has(char)) return false
  return true
}

async function searchFile(file: string, base: string, re: RegExp, literal: string | undefined): Promise<string[]> {
  const matches: string[] = []
  const relFile = relative(base, file)
  let lineNumber = 1
  if (literal !== undefined) {
    const decoder = new StringDecoder('utf8')
    const overlap = literal.length - 1
    let partialPrefix = ''
    let partialTail = ''
    let partialMatched = false
    const consumePartial = (segment: string): void => {
      if (partialPrefix.length < 200) partialPrefix += segment.slice(0, 200 - partialPrefix.length)
      if (partialMatched) return
      if (segment.includes(literal)
        || (partialTail.length > 0 && `${partialTail}${segment.slice(0, overlap)}`.includes(literal))) {
        partialMatched = true
        return
      }
      if (overlap > 0) {
        partialTail = segment.length >= overlap
          ? segment.slice(-overlap)
          : `${partialTail}${segment}`.slice(-overlap)
      }
    }
    const finishPartial = (): boolean => {
      if (partialMatched) matches.push(`${relFile}:${lineNumber}: ${partialPrefix}`)
      partialPrefix = ''
      partialTail = ''
      partialMatched = false
      lineNumber++
      return matches.length >= MAX_PER_FILE
    }
    try {
      const stream = createReadStream(file, { highWaterMark: 1024 * 1024 })
      for await (const chunk of stream) {
        const content = decoder.write(chunk as Buffer)
        const firstNewline = content.indexOf('\n')
        if (firstNewline < 0) {
          consumePartial(content)
          continue
        }
        consumePartial(content.slice(0, firstNewline))
        if (finishPartial()) return matches

        const completeEnd = content.lastIndexOf('\n') + 1
        let lineStart = firstNewline + 1
        let match = content.indexOf(literal, lineStart)
        while (match >= 0 && match < completeEnd) {
          let newline = content.indexOf('\n', lineStart)
          while (newline < match) {
            lineNumber++
            lineStart = newline + 1
            newline = content.indexOf('\n', lineStart)
          }
          matches.push(`${relFile}:${lineNumber}: ${content.slice(lineStart, newline).slice(0, 200)}`)
          if (matches.length >= MAX_PER_FILE) return matches
          lineNumber++
          lineStart = newline + 1
          match = content.indexOf(literal, lineStart)
        }
        let newline = content.indexOf('\n', lineStart)
        while (newline >= 0 && newline < completeEnd) {
          lineNumber++
          lineStart = newline + 1
          newline = content.indexOf('\n', lineStart)
        }
        consumePartial(content.slice(completeEnd))
      }
      consumePartial(decoder.end())
      finishPartial()
    } catch {
      return []
    }
    return matches
  }
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch {
    return []
  }
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
    const literal = isLiteralPattern(pattern) ? pattern : undefined

    const lines: string[] = []
    let truncated = false
    let stopped = false
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
    for await (const file of walkTextFiles(base)) {
      pending.push(file)
      if (pending.length >= READ_CONCURRENCY && await flush()) {
        stopped = true
        break
      }
    }
    if (!stopped && pending.length > 0) await flush()

    const out = lines.length === 0 ? '未找到匹配内容' : lines.join('\n')
    return { success: true, output: out + (truncated ? '\n…[结果过多已截断]' : ''), truncated }
  },
}
