import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { createRuntimeId } from './ids.ts'
import type { RuntimeEvent, RuntimeEventInput } from './events.ts'

interface RuntimeEventIndex {
  lastSeq: number
  segments: string[]
  activeBytes?: number
}

interface RuntimeEventState extends RuntimeEventIndex {
  activeBytes: number
  pending: number
}

interface RuntimeEventPaths {
  safe: string
  file: string
  index: string
  lock: string
  segmentPrefix: string
}

interface RuntimeReadCache {
  signature: string
  events: RuntimeEvent[]
}

function cloneRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return event.payload === undefined ? { ...event } : { ...event, payload: structuredClone(event.payload) }
}

export class RuntimeEventLog {
  private waiters = new Map<string, Set<(event: RuntimeEvent) => void>>()
  private readonly root: string
  private readonly maxBytes: number
  private readonly checkpointInterval: number
  private states = new Map<string, RuntimeEventState>()
  private paths = new Map<string, RuntimeEventPaths>()
  private readCache = new Map<string, Map<string, RuntimeReadCache>>()
  private rootReady = false

  constructor(root: string, options: { maxBytes?: number; checkpointInterval?: number } = {}) {
    this.root = root
    this.maxBytes = Math.max(1024, options.maxBytes ?? 8 * 1024 * 1024)
    this.checkpointInterval = Math.max(1, Math.floor(options.checkpointInterval ?? 32))
  }

  private ensureRoot(): void {
    if (this.rootReady) return
    mkdirSync(this.root, { recursive: true })
    this.rootReady = true
  }

  private pathsFor(sessionId: string): RuntimeEventPaths {
    const cached = this.paths.get(sessionId)
    if (cached) return cached
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const resolved = safe === sessionId
      ? safe
      : `${safe || 'session'}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`
    const paths = {
      safe: resolved,
      file: join(this.root, `${resolved}.jsonl`),
      index: join(this.root, `${resolved}.index.json`),
      lock: join(this.root, `${resolved}.lock`),
      segmentPrefix: `${resolved}.segment-`,
    }
    this.paths.set(sessionId, paths)
    return paths
  }

  private fileFor(sessionId: string): string {
    return this.pathsFor(sessionId).file
  }

  private indexFor(sessionId: string): string {
    return this.pathsFor(sessionId).index
  }

  private lockFor(sessionId: string): string {
    return this.pathsFor(sessionId).lock
  }

  private readIndex(sessionId: string): RuntimeEventIndex | null {
    const file = this.indexFor(sessionId)
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeEventIndex>
      if (typeof value.lastSeq !== 'number' || !Array.isArray(value.segments)) return null
      return {
        lastSeq: value.lastSeq,
        segments: value.segments.filter((item): item is string => typeof item === 'string'),
        ...(typeof value.activeBytes === 'number' && value.activeBytes >= 0 ? { activeBytes: value.activeBytes } : {}),
      }
    } catch {
      return null
    }
  }

  private discoverSegments(sessionId: string): string[] {
    const prefix = this.pathsFor(sessionId).segmentPrefix
    try {
      return readdirSync(this.root).filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl')).sort()
    } catch {
      return []
    }
  }

  private segmentFiles(sessionId: string, index = this.readIndex(sessionId)): string[] {
    const { safe, segmentPrefix: prefix } = this.pathsFor(sessionId)
    const names = [...(index?.segments ?? []), ...this.discoverSegments(sessionId), `${safe}.jsonl`]
    return [...new Set(names)]
      .filter((name) => name === `${safe}.jsonl` || (basename(name) === name && name.startsWith(prefix) && name.endsWith('.jsonl')))
      .map((name) => join(this.root, name))
      .filter((file) => {
        try {
          statSync(file)
          return true
        } catch {
          return false
        }
      })
  }

  private lastSeq(file: string): number {
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return 0
    }
    if (size === 0) return 0
    const fd = openSync(file, 'r')
    try {
      let length = Math.min(size, 64 * 1024)
      while (length > 0) {
        const buffer = Buffer.allocUnsafe(length)
        const position = size - length
        let bytesRead = 0
        while (bytesRead < length) {
          const count = readSync(fd, buffer, bytesRead, length - bytesRead, position + bytesRead)
          if (count === 0) break
          bytesRead += count
        }
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
        const firstComplete = length === size ? 0 : 1
        for (let i = lines.length - 1; i >= firstComplete; i--) {
          if (!lines[i].trim()) continue
          try {
            const event = JSON.parse(lines[i]) as RuntimeEvent
            if (typeof event.seq === 'number' && Number.isFinite(event.seq)) return event.seq
          } catch {
          }
        }
        if (length === size) return 0
        length = Math.min(size, length * 2)
      }
      return 0
    } finally {
      closeSync(fd)
    }
  }

  private readSignature(files: readonly string[]): string {
    return files.map((file) => {
      try {
        const stats = statSync(file)
        return `${file}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
      } catch {
        return `${file}:missing`
      }
    }).join('|')
  }

  private acquireLock(sessionId: string): string {
    const lock = this.lockFor(sessionId)
    for (let attempt = 0; attempt < 1000; attempt++) {
      try {
        const fd = openSync(lock, 'wx')
        closeSync(fd)
        return lock
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          this.rootReady = false
          this.ensureRoot()
          continue
        }
        if (code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30000) unlinkSync(lock)
        } catch {
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
      }
    }
    throw new Error(`RuntimeEventLog 获取锁超时: ${sessionId}`)
  }

  private writeIndex(sessionId: string, index: RuntimeEventIndex): void {
    const file = this.indexFor(sessionId)
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    const content = JSON.stringify(index)
    try {
      writeFileSync(temp, content, 'utf8')
      try {
        renameSync(temp, file)
      } catch {
        writeFileSync(file, content, 'utf8')
        unlinkSync(temp)
      }
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
      }
      throw error
    }
  }

  append(input: RuntimeEventInput): RuntimeEvent {
    return this.appendBatch([input])[0]!
  }

  appendBatch(inputs: readonly RuntimeEventInput[]): RuntimeEvent[] {
    if (inputs.length === 0) return []
    this.ensureRoot()
    const sessionId = inputs[0].sessionId
    if (inputs.some((input) => input.sessionId !== sessionId)) throw new Error('RuntimeEventLog 批量事件必须属于同一会话')
    const lock = this.acquireLock(sessionId)
    let events: RuntimeEvent[] = []
    try {
      const activeFile = this.fileFor(sessionId)
      let activeExists = true
      let activeBytes = 0
      try {
        activeBytes = statSync(activeFile).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        activeExists = false
      }
      const cached = this.states.get(sessionId)
      const cacheValid = activeExists && cached?.activeBytes === activeBytes
      const previous = cacheValid ? cached : this.readIndex(sessionId)
      const segments = [...new Set(previous?.segments ?? [])]
      const diskSeq = previous && activeExists && previous.activeBytes === activeBytes
        ? previous.lastSeq
        : this.segmentFiles(sessionId, previous).reduce((max, file) => Math.max(max, this.lastSeq(file)), 0)
      const seq = Math.max(previous?.lastSeq ?? 0, diskSeq) + 1
      const shouldRotate = activeExists && activeBytes >= this.maxBytes
      if (shouldRotate) {
        segments.push(...this.discoverSegments(sessionId))
        const rotated = join(this.root, `${this.pathsFor(sessionId).segmentPrefix}${String(seq - 1).padStart(12, '0')}-${Date.now()}.jsonl`)
        renameSync(activeFile, rotated)
        segments.push(rotated.split(/[\\/]/).pop()!)
      }
      events = inputs.map((input, index) => ({ ...input, eventId: createRuntimeId('event'), seq: seq + index, ts: Date.now() }))
      const content = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
      appendFileSync(activeFile, content, 'utf8')
      const state: RuntimeEventState = {
        lastSeq: seq + events.length - 1,
        segments: [...new Set(segments)],
        activeBytes: (shouldRotate ? 0 : activeBytes) + Buffer.byteLength(content, 'utf8'),
        pending: (cacheValid ? cached.pending : 0) + events.length,
      }
      this.states.set(sessionId, state)
      this.readCache.delete(sessionId)
      if (shouldRotate || state.pending >= this.checkpointInterval || inputs.some((input) => input.type === 'run_finished')) {
        this.writeIndex(sessionId, state)
        state.pending = 0
      }
    } finally {
      try {
        unlinkSync(lock)
      } catch {
      }
    }
    const waiters = this.waiters.get(sessionId)
    if (waiters) {
      this.waiters.delete(sessionId)
      for (const waiter of waiters) waiter(events[0])
    }
    return events
  }

  waitForEvent(sessionId: string, timeoutMs = 0): Promise<RuntimeEvent | null> {
    this.ensureRoot()
    return new Promise((resolve) => {
      const activeFile = this.fileFor(sessionId)
      const listeners = this.waiters.get(sessionId) ?? new Set<(event: RuntimeEvent) => void>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let watcher: FSWatcher | undefined
      let settled = false
      let cursor = 0
      let identity = ''
      let remainder = Buffer.alloc(0)
      try {
        const stats = statSync(activeFile)
        cursor = stats.size
        identity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
      } catch {
      }
      const finish = (event: RuntimeEvent | null): void => {
        if (settled) return
        settled = true
        listeners.delete(onEvent)
        if (listeners.size === 0) this.waiters.delete(sessionId)
        if (timer) clearTimeout(timer)
        watcher?.close()
        resolve(event)
      }
      const onEvent = (event: RuntimeEvent): void => finish(event)
      const checkExternal = (): void => {
        try {
          const stats = statSync(activeFile)
          const nextIdentity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
          if (nextIdentity !== identity || stats.size < cursor) {
            identity = nextIdentity
            cursor = 0
            remainder = Buffer.alloc(0)
          }
          const length = stats.size - cursor
          if (length <= 0) return
          const buffer = Buffer.allocUnsafe(length)
          const fd = openSync(activeFile, 'r')
          let bytesRead = 0
          try {
            while (bytesRead < length) {
              const count = readSync(fd, buffer, bytesRead, length - bytesRead, cursor + bytesRead)
              if (count === 0) break
              bytesRead += count
            }
          } finally {
            closeSync(fd)
          }
          cursor += bytesRead
          const content = Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
          let lineStart = 0
          for (let i = 0; i < content.length; i++) {
            if (content[i] !== 10) continue
            const line = content.subarray(lineStart, i).toString('utf8')
            lineStart = i + 1
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line) as RuntimeEvent
              if (event.sessionId === sessionId) {
                finish(event)
                return
              }
            } catch {
            }
          }
          remainder = content.subarray(lineStart)
        } catch {
        }
      }
      listeners.add(onEvent)
      this.waiters.set(sessionId, listeners)
      try {
        watcher = watch(this.root, { persistent: false }, () => checkExternal())
      } catch {
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(null), timeoutMs)
      }
      checkExternal()
    })
  }

  read(sessionId: string, options: { type?: RuntimeEvent['type'] } = {}): RuntimeEvent[] {
    const files = this.segmentFiles(sessionId)
    const signature = this.readSignature(files)
    const typeKey = options.type ?? ''
    const sessionCache = this.readCache.get(sessionId)
    const cached = sessionCache?.get(typeKey)
    if (cached?.signature === signature) return cached.events.map(cloneRuntimeEvent)
    const events: RuntimeEvent[] = []
    let ordered = true
    let previousSeq = Number.NEGATIVE_INFINITY
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    const typeMarker = options.type ? `"type":"${options.type}"` : undefined
    const typePattern = options.type ? new RegExp(`"type"\\s*:\\s*"${options.type}"`) : undefined
    const acceptLine = (line: string): void => {
      if (line.length === 0) return
      if (typeMarker && !line.includes(typeMarker) && !typePattern!.test(line)) return
      try {
        const event = JSON.parse(line) as RuntimeEvent
        if (options.type && event.type !== options.type) return
        if (event.seq < previousSeq) ordered = false
        previousSeq = event.seq
        events.push(event)
      } catch {
      }
    }
    for (const file of files) {
      if (statSync(file).size <= this.maxBytes * 2) {
        const content = readFileSync(file, 'utf8')
        let lineStart = 0
        while (lineStart < content.length) {
          const newline = content.indexOf('\n', lineStart)
          const lineEnd = newline < 0 ? content.length : newline
          acceptLine(content.slice(lineStart, lineEnd))
          lineStart = lineEnd + 1
        }
        continue
      }
      const fd = openSync(file, 'r')
      const partial: Buffer[] = []
      let partialBytes = 0
      try {
        while (true) {
          const bytesRead = readSync(fd, chunk, 0, chunk.length, null)
          if (bytesRead === 0) break
          let lineStart = 0
          for (let i = 0; i < bytesRead; i++) {
            if (chunk[i] !== 10) continue
            const segment = chunk.subarray(lineStart, i)
            if (partial.length === 0) {
              acceptLine(segment.toString('utf8'))
            } else {
              partial.push(segment)
              acceptLine(Buffer.concat(partial, partialBytes + segment.length).toString('utf8'))
              partial.length = 0
              partialBytes = 0
            }
            lineStart = i + 1
          }
          if (lineStart < bytesRead) {
            const remainder = Buffer.from(chunk.subarray(lineStart, bytesRead))
            partial.push(remainder)
            partialBytes += remainder.length
          }
        }
        if (partialBytes > 0) acceptLine(Buffer.concat(partial, partialBytes).toString('utf8'))
      } finally {
        closeSync(fd)
      }
    }
    const result = ordered ? events : events.sort((a, b) => a.seq - b.seq)
    const nextCache = sessionCache ?? new Map<string, RuntimeReadCache>()
    nextCache.set(typeKey, { signature, events: result })
    this.readCache.set(sessionId, nextCache)
    return result.map(cloneRuntimeEvent)
  }
}
