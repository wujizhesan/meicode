import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, isAbsolute, relative, resolve } from 'node:path'
import { Minimatch } from 'minimatch'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { MAX_RESULT_BYTES, truncateOutput } from './types.ts'

const MAX_RESULTS = 100
const READ_CONCURRENCY = 16
const MAX_CACHED_DIRS = 4096
const MAX_CACHED_ENTRIES = 50_000
const RECENT_DIRECTORY_WINDOW_MS = 2000

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('查找已取消')
}

interface CachedDirectory {
  entries: Dirent[]
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
}

const directoryCache = new Map<string, CachedDirectory>()
let cachedEntryCount = 0

function compareEntriesByPath(a: Dirent, b: Dirent): number {
  const left = a.isDirectory() ? `${a.name}/` : a.name
  const right = b.isDirectory() ? `${b.name}/` : b.name
  return left < right ? -1 : left > right ? 1 : 0
}

async function readDirectory(dir: string): Promise<Dirent[]> {
  const key = resolve(dir)
  const metadata = await stat(key, { bigint: true })
  const cached = directoryCache.get(key)
  const stableBefore = BigInt(Date.now() - RECENT_DIRECTORY_WINDOW_MS) * 1_000_000n
  if (cached && metadata.mtimeNs < stableBefore && metadata.ctimeNs < stableBefore
    && cached.mtimeNs === metadata.mtimeNs && cached.ctimeNs === metadata.ctimeNs && cached.ino === metadata.ino) {
    directoryCache.delete(key)
    directoryCache.set(key, cached)
    return cached.entries
  }

  const entries = (await readdir(key, { withFileTypes: true })).sort(compareEntriesByPath)
  if (cached) cachedEntryCount -= cached.entries.length
  directoryCache.delete(key)
  if (entries.length <= MAX_CACHED_ENTRIES) {
    directoryCache.set(key, { entries, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs, ino: metadata.ino })
    cachedEntryCount += entries.length
    while (directoryCache.size > MAX_CACHED_DIRS || cachedEntryCount > MAX_CACHED_ENTRIES) {
      const oldest = directoryCache.keys().next().value
      if (oldest === undefined) break
      cachedEntryCount -= directoryCache.get(oldest)!.entries.length
      directoryCache.delete(oldest)
    }
  }
  return entries
}

type DirectoryRead = { entries: Dirent[] } | { error: unknown }

function fixedDirectoryPrefix(matcher: Minimatch): string[] {
  if (matcher.negate || matcher.comment || matcher.empty || matcher.set.length === 0) return []
  const prefix: string[] = []
  for (let index = 0; ; index++) {
    let segment: string | undefined
    for (const alternative of matcher.set) {
      if (index >= alternative.length - 1) return prefix
      const part = alternative[index]
      if (typeof part !== 'string' || !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) return prefix
      if (segment !== undefined && segment !== part) return prefix
      segment = part
    }
    prefix.push(segment!)
  }
}

function maxSearchDepth(matcher: Minimatch): number {
  if (matcher.negate || matcher.comment || matcher.empty || matcher.set.length === 0) return Infinity
  let maxDepth = 0
  for (const alternative of matcher.set) {
    if (alternative.some((part) => typeof part === 'symbol' || (typeof part === 'string' && part.includes('/')))) return Infinity
    maxDepth = Math.max(maxDepth, alternative.length)
  }
  return maxDepth
}

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
      void readDirectory(pending.dir)
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

async function* walkFiles(
  dir: string,
  base: string,
  pool: ReaddirPool,
  prefix: readonly string[],
  maxDepth: number,
  signal?: AbortSignal,
  depth = 0,
  load: Promise<DirectoryRead> = pool.read(dir),
): AsyncGenerator<string> {
  throwIfAborted(signal)
  const result = await load
  throwIfAborted(signal)
  if ('error' in result) throw result.error
  const entries = result.entries
  const requiredChild = prefix[0]
  const canDescend = depth + 1 < maxDepth
  const childReads = new Map<number, Promise<DirectoryRead>>()
  for (let i = 0; i < entries.length; i++) {
    throwIfAborted(signal)
    const entry = entries[i]
    if (canDescend && entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git'
      && (requiredChild === undefined || entry.name === requiredChild)) {
      childReads.set(i, pool.read(join(dir, entry.name)))
    }
  }
  for (let i = 0; i < entries.length; i++) {
    throwIfAborted(signal)
    const entry = entries[i]
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isDirectory()) {
      if (!canDescend || (requiredChild !== undefined && entry.name !== requiredChild)) continue
      yield* walkFiles(join(dir, entry.name), base, pool, requiredChild === undefined ? prefix : prefix.slice(1), maxDepth, signal, depth + 1, childReads.get(i)!)
    } else if (entry.isFile() && requiredChild === undefined) {
      yield relative(base, join(dir, entry.name)).replaceAll('\\', '/')
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
    if (ctx.signal?.aborted) return { success: false, output: '', error: '查找失败: 查找已取消' }
    const base = typeof args.path === 'string' && args.path ? (isAbsolute(args.path) ? args.path : join(ctx.cwd, args.path)) : ctx.cwd

    const results: string[] = []
    const pool = new ReaddirPool()
    const onAbort = () => pool.cancel()
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      throwIfAborted(ctx.signal)
      const matcher = new Minimatch(pattern)
      const prefix = fixedDirectoryPrefix(matcher)
      const maxDepth = maxSearchDepth(matcher)
      for await (const entry of walkFiles(base, base, pool, prefix, maxDepth, ctx.signal)) {
        throwIfAborted(ctx.signal)
        if (!matcher.match(entry)) continue
        results.push(entry)
        if (results.length > MAX_RESULTS) break
      }
      throwIfAborted(ctx.signal)
    } catch (e) {
      return { success: false, output: '', error: `查找失败: ${(e as Error).message}` }
    } finally {
      pool.cancel()
      ctx.signal?.removeEventListener('abort', onAbort)
    }

    results.sort()
    if (results.length === 0) return { success: true, output: '未找到匹配文件', truncated: false }

    const countLimited = results.length > MAX_RESULTS
    const candidates = countLimited ? results.slice(0, MAX_RESULTS) : results
    const listed: string[] = []
    let outputBytes = 0
    for (const path of candidates) {
      const nextBytes = Buffer.byteLength(path, 'utf8') + (listed.length === 0 ? 0 : 1)
      if (outputBytes + nextBytes > MAX_RESULT_BYTES) break
      listed.push(path)
      outputBytes += nextBytes
    }
    const truncated = countLimited || listed.length < candidates.length
    if (!truncated) return { success: true, output: listed.join('\n'), truncated: false }

    let suffix = `\n…[仅显示前 ${listed.length} 条]`
    while (listed.length > 0 && outputBytes + Buffer.byteLength(suffix, 'utf8') > MAX_RESULT_BYTES) {
      const removed = listed.pop()!
      outputBytes -= Buffer.byteLength(removed, 'utf8') + (listed.length === 0 ? 0 : 1)
      suffix = `\n…[仅显示前 ${listed.length} 条]`
    }
    if (listed.length === 0) {
      return { success: true, output: truncateOutput(candidates[0] + '\n…[结果已截断]').output, truncated: true }
    }
    return { success: true, output: listed.join('\n') + suffix, truncated: true }
  },
}
