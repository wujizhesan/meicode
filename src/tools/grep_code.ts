import { createReadStream, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, isAbsolute, relative, extname, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { MAX_RESULT_BYTES, truncateOutput } from './types.ts'

const MAX_LINES = 200
const TRUNCATED_SUFFIX = '\n…[结果过多已截断]'
const MAX_PER_FILE = 20
const READ_CONCURRENCY = 16
const READ_CHUNK_BYTES = 1024 * 1024
const MAX_LINE_PREFIX_BYTES = 800
const MAX_SEARCH_CACHE = 4096
const MAX_CACHED_PATTERN_LENGTH = 1024
const RECENT_FILE_WINDOW_MS = 2000

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('搜索已取消')
}

function previewLine(text: string): string {
  let end = Math.min(200, text.length)
  if (end < text.length) {
    const last = text.charCodeAt(end - 1)
    const next = text.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++
  }
  return text.slice(0, end)
}

interface CachedSearch {
  stamp: string
  matches: string[]
}

const searchCache = new Map<string, CachedSearch>()

async function fileStamp(file: string): Promise<{ value: string; reusable: boolean }> {
  const stats = await stat(file, { bigint: true })
  const stableBefore = BigInt(Date.now() - RECENT_FILE_WINDOW_MS) * 1_000_000n
  return {
    value: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
    reusable: stats.mtimeNs < stableBefore && stats.ctimeNs < stableBefore,
  }
}
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
  private readonly inflight = new Set<PendingRead>()

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
    for (const pending of this.inflight) pending.resolve({ error: new Error('directory read cancelled') })
    this.inflight.clear()
  }

  private pump(): void {
    while (!this.cancelled && this.active < READ_CONCURRENCY && this.queue.length > 0) {
      const pending = this.queue.shift()!
      this.active++
      this.inflight.add(pending)
      void readdir(pending.dir, { withFileTypes: true })
        .then(
          (entries) => pending.resolve({ entries }),
          (error: unknown) => pending.resolve({ error }),
        )
        .finally(() => {
          this.inflight.delete(pending)
          this.active--
          this.pump()
        })
    }
  }
}

async function* walkTextFiles(
  dir: string,
  pool: ReaddirPool,
  signal?: AbortSignal,
  load: Promise<DirectoryRead> = pool.read(dir),
): AsyncGenerator<string> {
  throwIfAborted(signal)
  const result = await load
  throwIfAborted(signal)
  if ('error' in result) throw result.error
  const entries = result.entries
  const childReads = new Map<number, Promise<DirectoryRead>>()
  for (let index = 0; index < entries.length; index++) {
    throwIfAborted(signal)
    const entry = entries[index]
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
      childReads.set(index, pool.read(join(dir, entry.name)))
    }
  }
  for (let index = 0; index < entries.length; index++) {
    throwIfAborted(signal)
    const e = entries[index]
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      yield* walkTextFiles(p, pool, signal, childReads.get(index)!)
    } else if (e.isFile() && !BINARY_EXT.has(extname(e.name).toLowerCase())) {
      yield p
    }
  }
}

function isLiteralPattern(pattern: string): boolean {
  for (const char of pattern) if (REGEXP_META.has(char)) return false
  return true
}

// biome-ignore lint/complexity/noUselessStringRaw: 这是注入 worker 的源码文本，String.raw 是必需的——它保证反斜杠原样传给 worker，用普通模板串会被 JS 提前吃掉正则的转义序列
const REGEX_WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')
const { createReadStream } = require('node:fs')
const MAX_PER_FILE = ${MAX_PER_FILE}
const READ_CHUNK_BYTES = ${READ_CHUNK_BYTES}

function previewLine(text) {
  let end = Math.min(200, text.length)
  if (end < text.length) {
    const last = text.charCodeAt(end - 1)
    const next = text.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++
  }
  return text.slice(0, end)
}

async function search(file, relFile, pattern) {
  const stream = createReadStream(file, { highWaterMark: READ_CHUNK_BYTES })
  const re = new RegExp(pattern)
  const matches = []
  let lineNumber = 1
  const parts = []
  let lineBytes = 0
  const addPart = (part) => {
    if (part.length === 0) return
    parts.push(part)
    lineBytes += part.length
  }
  const finishLine = () => {
    const line = lineBytes === 0 ? '' : (parts.length === 1 ? parts[0] : Buffer.concat(parts, lineBytes)).toString('utf8')
    if (re.test(line)) matches.push(relFile + ':' + lineNumber + ': ' + previewLine(line))
    parts.length = 0
    lineBytes = 0
    lineNumber++
  }
  try {
    for await (const chunk of stream) {
      let start = 0
      while (true) {
        const newline = chunk.indexOf(10, start)
        if (newline < 0) {
          addPart(chunk.subarray(start))
          break
        }
        addPart(chunk.subarray(start, newline))
        finishLine()
        if (matches.length > MAX_PER_FILE) return matches
        start = newline + 1
      }
    }
    finishLine()
    return matches
  } catch {
    return null
  } finally {
    stream.destroy()
  }
}

parentPort.on('message', ({ id, file, relFile, pattern }) => {
  void search(file, relFile, pattern)
    .then((matches) => parentPort.postMessage({ id, matches }))
    .catch((error) => parentPort.postMessage({ id, error: String(error) }))
})
`

interface RegexResponse {
  id: number
  matches?: string[] | null
  error?: string
}

class RegexSearchWorker {
  private readonly worker = new Worker(REGEX_WORKER_SOURCE, { eval: true, execArgv: [] })
  private readonly pending = new Map<number, { resolve: (matches: string[] | null) => void; reject: (error: Error) => void }>()
  private readonly timer: NodeJS.Timeout
  private readonly pattern: string
  private readonly signal?: AbortSignal
  private nextId = 0
  private failure: Error | null = null

  constructor(pattern: string, timeoutMs: number, signal?: AbortSignal) {
    this.pattern = pattern
    this.signal = signal
    this.worker.on('message', (message: RegexResponse) => {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.matches ?? null)
    })
    this.worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.worker.on('exit', (code) => this.fail(new Error(`正则搜索 Worker 退出（${code}）`)))
    this.timer = setTimeout(() => this.fail(new Error(`正则搜索超时（${timeoutMs}ms）`)), timeoutMs)
    this.signal?.addEventListener('abort', this.onAbort, { once: true })
    if (this.signal?.aborted) this.onAbort()
  }

  private readonly onAbort = (): void => { this.fail(new Error('正则搜索已取消')) }

  scan(file: string, relFile: string): Promise<string[] | null> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ id, file, relFile, pattern: this.pattern })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.timer)
    this.signal?.removeEventListener('abort', this.onAbort)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    void this.worker.terminate().catch(() => {})
  }

  close(): void {
    this.fail(new Error('正则搜索已结束'))
  }
}

async function searchLiteralFile(file: string, relFile: string, literal: string, signal?: AbortSignal): Promise<string[] | null> {
  throwIfAborted(signal)
  const stream = createReadStream(file, { highWaterMark: READ_CHUNK_BYTES, signal })
  const matches: string[] = []
  const needle = Buffer.from(literal)
  const prefix = Buffer.allocUnsafe(MAX_LINE_PREFIX_BYTES)
  let prefixLength = 0
  let tail: Buffer | null = null
  let matched = false
  let lineNumber = 1
  const scan = (part: Buffer, completeLine: boolean): void => {
    if (prefixLength < MAX_LINE_PREFIX_BYTES) {
      prefixLength += part.copy(prefix, prefixLength, 0, MAX_LINE_PREFIX_BYTES - prefixLength)
    }
    if (matched || part.length === 0) return
    const candidate = tail === null ? part : Buffer.concat([tail, part])
    if (candidate.indexOf(needle) >= 0) matched = true
    if (!matched && !completeLine && needle.length > 1) {
      const keep = Math.min(needle.length - 1, candidate.length)
      tail = candidate.subarray(candidate.length - keep)
    }
  }
  const addMatch = (): void => {
    matches.push(`${relFile}:${lineNumber}: ${previewLine(prefix.subarray(0, prefixLength).toString('utf8'))}`)
  }
  const finishLine = (): void => {
    if (matched) addMatch()
    lineNumber++
    prefixLength = 0
    tail = null
    matched = false
  }
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        if (newline < 0) {
          scan(chunk.subarray(start), false)
          break
        }
        scan(chunk.subarray(start, newline), true)
        finishLine()
        if (matches.length > MAX_PER_FILE) return matches
        start = newline + 1
      }
    }
    if (matched) finishLine()
    return matches
  } catch {
    throwIfAborted(signal)
    return null
  } finally {
    stream.destroy()
  }
}

async function searchFile(file: string, base: string, literal: string | undefined, pattern: string, regexWorker?: RegexSearchWorker, signal?: AbortSignal): Promise<string[]> {
  const relFile = relative(base, file)
  const scan = () => literal === undefined ? regexWorker!.scan(file, relFile) : searchLiteralFile(file, relFile, literal, signal)
  if (pattern.length > MAX_CACHED_PATTERN_LENGTH) return (await scan()) ?? []

  const key = JSON.stringify([resolve(file), relFile, pattern])
  let stamp: Awaited<ReturnType<typeof fileStamp>>
  try {
    stamp = await fileStamp(file)
  } catch {
    searchCache.delete(key)
    return []
  }
  if (!stamp.reusable) {
    searchCache.delete(key)
    return (await scan()) ?? []
  }
  const cached = searchCache.get(key)
  if (cached?.stamp === stamp.value) {
    searchCache.delete(key)
    searchCache.set(key, cached)
    return cached.matches
  }
  searchCache.delete(key)

  const matches = await scan()
  if (matches === null) return []
  try {
    const after = await fileStamp(file)
    if (!after.reusable || stamp.value !== after.value) return matches
  } catch {
    return matches
  }
  searchCache.set(key, { stamp: stamp.value, matches })
  while (searchCache.size > MAX_SEARCH_CACHE) searchCache.delete(searchCache.keys().next().value!)
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
    if (ctx.signal?.aborted) return { success: false, output: '', error: '搜索失败: 搜索已取消' }
    const base = typeof args.path === 'string' && args.path ? (isAbsolute(args.path) ? args.path : join(ctx.cwd, args.path)) : ctx.cwd

    const literal = isLiteralPattern(pattern) ? pattern : undefined
    try {
      new RegExp(pattern)
    } catch (e) {
      return { success: false, output: '', error: `非法正则: ${(e as Error).message}` }
    }
    let regexWorker: RegexSearchWorker | undefined
    if (literal === undefined) {
      const timeoutMs = typeof ctx.timeoutMs === 'number' && Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0
        ? Math.min(ctx.timeoutMs, 2_147_483_647)
        : 30_000
      try {
        regexWorker = new RegexSearchWorker(pattern, timeoutMs, ctx.signal)
      } catch (e) {
        return { success: false, output: '', error: `搜索失败: ${(e as Error).message}` }
      }
    }
    const lines: string[] = []
    const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8')
    let outputBytes = 0
    let oversizedOutput: string | undefined
    let truncated = false
    let stopped = false
    const pool = new ReaddirPool()
    const onAbort = () => pool.cancel()
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    const pending: string[] = []
    const flush = async (): Promise<boolean> => {
      throwIfAborted(ctx.signal)
      const batches = await Promise.all(pending.map((file) => searchFile(file, base, literal, pattern, regexWorker, ctx.signal)))
      throwIfAborted(ctx.signal)
      pending.length = 0
      for (const matches of batches) {
        if (matches.length > MAX_PER_FILE) truncated = true
        for (const match of matches.slice(0, MAX_PER_FILE)) {
          if (lines.length >= MAX_LINES) {
            truncated = true
            return true
          }
          const nextBytes = Buffer.byteLength(match, 'utf8') + (lines.length === 0 ? 0 : 1)
          if (outputBytes + nextBytes > MAX_RESULT_BYTES) {
            truncated = true
            if (lines.length === 0) oversizedOutput = truncateOutput(match + TRUNCATED_SUFFIX).output
            return true
          }
          lines.push(match)
          outputBytes += nextBytes
        }
      }
      return false
    }
    try {
      throwIfAborted(ctx.signal)
      for await (const file of walkTextFiles(base, pool, ctx.signal)) {
        pending.push(file)
        if (pending.length >= READ_CONCURRENCY && await flush()) {
          stopped = true
          break
        }
      }
      if (!stopped && pending.length > 0) await flush()
      throwIfAborted(ctx.signal)
    } catch (e) {
      return { success: false, output: '', error: `搜索失败: ${(e as Error).message}` }
    } finally {
      pool.cancel()
      ctx.signal?.removeEventListener('abort', onAbort)
      regexWorker?.close()
    }

    if (truncated && oversizedOutput === undefined) {
      while (outputBytes + suffixBytes > MAX_RESULT_BYTES && lines.length > 0) {
        const last = lines.pop()!
        outputBytes -= Buffer.byteLength(last, 'utf8') + (lines.length === 0 ? 0 : 1)
      }
    }
    const output = oversizedOutput ?? (lines.length === 0
      ? (truncated ? TRUNCATED_SUFFIX.slice(1) : '未找到匹配内容')
      : lines.join('\n') + (truncated ? TRUNCATED_SUFFIX : ''))
    return { success: true, output, truncated }
  },
}
