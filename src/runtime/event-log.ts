import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { createRuntimeId } from './ids.ts'
import type { RuntimeEvent, RuntimeEventInput } from './events.ts'

interface RuntimeEventIndex {
  lastSeq: number
  segments: string[]
}

export class RuntimeEventLog {
  private waiters = new Map<string, Set<(event: RuntimeEvent) => void>>()
  private readonly root: string
  private readonly maxBytes: number

  constructor(root: string, options: { maxBytes?: number } = {}) {
    this.root = root
    this.maxBytes = Math.max(1024, options.maxBytes ?? 8 * 1024 * 1024)
    mkdirSync(root, { recursive: true })
  }

  private safeSessionId(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_')
    if (safe === sessionId) return safe
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
    return `${safe || 'session'}-${hash}`
  }

  private fileFor(sessionId: string): string {
    return join(this.root, `${this.safeSessionId(sessionId)}.jsonl`)
  }

  private indexFor(sessionId: string): string {
    return join(this.root, `${this.safeSessionId(sessionId)}.index.json`)
  }

  private lockFor(sessionId: string): string {
    return join(this.root, `${this.safeSessionId(sessionId)}.lock`)
  }

  private readIndex(sessionId: string): RuntimeEventIndex | null {
    const file = this.indexFor(sessionId)
    if (!existsSync(file)) return null
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeEventIndex>
      if (typeof value.lastSeq !== 'number' || !Array.isArray(value.segments)) return null
      return { lastSeq: value.lastSeq, segments: value.segments.filter((item): item is string => typeof item === 'string') }
    } catch {
      return null
    }
  }

  private discoverSegments(sessionId: string): string[] {
    const prefix = `${this.safeSessionId(sessionId)}.segment-`
    return readdirSync(this.root).filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl')).sort()
  }

  private segmentFiles(sessionId: string): string[] {
    const index = this.readIndex(sessionId)
    const safe = this.safeSessionId(sessionId)
    const prefix = `${safe}.segment-`
    const names = [...(index?.segments ?? []), ...this.discoverSegments(sessionId), `${safe}.jsonl`]
    return [...new Set(names)]
      .filter((name) => name === `${safe}.jsonl` || (basename(name) === name && name.startsWith(prefix) && name.endsWith('.jsonl')))
      .map((name) => join(this.root, name))
      .filter((file) => existsSync(file))
  }

  private lastSeq(file: string): number {
    if (!existsSync(file)) return 0
    let seq = 0
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as RuntimeEvent
        if (event.seq > seq) seq = event.seq
      } catch {
      }
    }
    return seq
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
    mkdirSync(dirname(this.fileFor(input.sessionId)), { recursive: true })
    const lock = this.acquireLock(input.sessionId)
    let event: RuntimeEvent
    try {
      const activeFile = this.fileFor(input.sessionId)
      const previous = this.readIndex(input.sessionId)
      const activeExists = existsSync(activeFile)
      const segments = [...new Set(previous?.segments ?? [])]
      const diskSeq = previous && activeExists
        ? this.lastSeq(activeFile)
        : this.segmentFiles(input.sessionId).reduce((max, file) => Math.max(max, this.lastSeq(file)), 0)
      const seq = Math.max(previous?.lastSeq ?? 0, diskSeq) + 1
      if (activeExists && statSync(activeFile).size >= this.maxBytes) {
        segments.push(...this.discoverSegments(input.sessionId))
        const rotated = join(this.root, `${this.safeSessionId(input.sessionId)}.segment-${String(seq - 1).padStart(12, '0')}-${Date.now()}.jsonl`)
        renameSync(activeFile, rotated)
        segments.push(rotated.split(/[\\/]/).pop()!)
      }
      event = { ...input, eventId: createRuntimeId('event'), seq, ts: Date.now() }
      appendFileSync(activeFile, JSON.stringify(event) + '\n', 'utf8')
      this.writeIndex(input.sessionId, { lastSeq: seq, segments: [...new Set(segments)] })
    } finally {
      try {
        unlinkSync(lock)
      } catch {
      }
    }
    const waiters = this.waiters.get(input.sessionId)
    if (waiters) {
      this.waiters.delete(input.sessionId)
      for (const waiter of waiters) waiter(event)
    }
    return event
  }

  waitForEvent(sessionId: string, timeoutMs = 0): Promise<RuntimeEvent | null> {
    return new Promise((resolve) => {
      const baseline = this.read(sessionId).reduce((max, event) => Math.max(max, event.seq), 0)
      const listeners = this.waiters.get(sessionId) ?? new Set<(event: RuntimeEvent) => void>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let watcher: FSWatcher | undefined
      let settled = false
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
        const event = this.read(sessionId).find((item) => item.seq > baseline)
        if (event) finish(event)
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

  read(sessionId: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = []
    for (const file of this.segmentFiles(sessionId)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line) as RuntimeEvent)
        } catch {
        }
      }
    }
    return events.sort((a, b) => a.seq - b.seq)
  }
}
