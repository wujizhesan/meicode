import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFile, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { guardPath } from './types.ts'
import type { ToolContext } from './types.ts'

interface TemporaryFile {
  destination: string
  path: string
  fd: number
  mode?: number
  identity?: { dev: number; ino: number }
  closed: boolean
  committed: boolean
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function checkWrite(destination: string, ctx: ToolContext): void {
  if (ctx.signal?.aborted) throw new Error('写入已取消')
  const blocked = guardPath(ctx, destination)
  if (blocked) throw new Error(blocked)
}

function closeTemporary(file: TemporaryFile): void {
  if (file.closed) return
  file.closed = true
  closeSync(file.fd)
}

function releaseTemporary(file: TemporaryFile, ctx: ToolContext): void {
  try {
    closeTemporary(file)
  } finally {
    if (!file.committed) {
      try {
        const current = lstatSync(file.path)
        if (!current.isSymbolicLink()
          && (!file.identity || (current.dev === file.identity.dev && current.ino === file.identity.ino))
          && samePath(realpathSync.native(dirname(file.path)), dirname(file.path))
          && !guardPath(ctx, file.path)) unlinkSync(file.path)
      } catch {
      }
    }
  }
}

function createTemporary(destination: string, ctx: ToolContext): TemporaryFile {
  checkWrite(destination, ctx)
  let existing: ReturnType<typeof statSync> | undefined
  try {
    existing = statSync(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing) {
    if (!existing.isFile()) throw new Error('目标不是普通文件')
    accessSync(destination, constants.W_OK)
  }
  const path = join(dirname(destination), `.meicode-write-${randomUUID()}.tmp`)
  const fd = openSync(path, 'wx', existing ? Number(existing.mode) : 0o666)
  const file: TemporaryFile = { destination, path, fd, mode: existing ? Number(existing.mode) & 0o777 : undefined, closed: false, committed: false }
  try {
    file.identity = fstatSync(fd)
    return file
  } catch (error) {
    releaseTemporary(file, ctx)
    throw error
  }
}

function commitTemporary(file: TemporaryFile, ctx: ToolContext): void {
  checkWrite(file.destination, ctx)
  if (file.mode !== undefined) fchmodSync(file.fd, file.mode)
  fsyncSync(file.fd)
  closeTemporary(file)
  checkWrite(file.destination, ctx)
  if (!samePath(realpathSync.native(dirname(file.destination)), dirname(file.destination))) throw new Error('目标目录在写入期间发生变化')
  const current = lstatSync(file.path)
  if (!file.identity || current.isSymbolicLink() || current.dev !== file.identity.dev || current.ino !== file.identity.ino) {
    throw new Error('临时文件在写入期间发生变化')
  }
  renameSync(file.path, file.destination)
  file.committed = true
}

export async function writeTextAtomic(destination: string, content: string, ctx: ToolContext): Promise<void> {
  const file = createTemporary(destination, ctx)
  try {
    await new Promise<void>((resolve, reject) => {
      writeFile(file.fd, content, 'utf8', (error) => error ? reject(error) : resolve())
    })
    commitTemporary(file, ctx)
  } finally {
    releaseTemporary(file, ctx)
  }
}

export function writeTextAtomicSync(destination: string, content: string, ctx: ToolContext): void {
  const file = createTemporary(destination, ctx)
  try {
    writeFileSync(file.fd, content, 'utf8')
    commitTemporary(file, ctx)
  } finally {
    releaseTemporary(file, ctx)
  }
}
