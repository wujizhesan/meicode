import { dirname } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function atomicWriteFile(file: string, content: string): void {
  const suffix = `${process.pid}.${randomUUID()}`
  const temp = `${file}.${suffix}.tmp`
  const backup = `${file}.${suffix}.bak`
  try {
    writeFileSync(temp, content, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, content, 'utf8')
  }
  try {
    renameSync(temp, file)
    return
  } catch {
  }
  let backupCreated = false
  let originalRemoved = false
  try {
    if (existsSync(file)) {
      copyFileSync(file, backup)
      backupCreated = true
      unlinkSync(file)
      originalRemoved = true
    }
    renameSync(temp, file)
  } catch (replaceError) {
    let restoreError: unknown
    if (backupCreated && !existsSync(file)) {
      try {
        renameSync(backup, file)
        backupCreated = false
      } catch (error) {
        restoreError = error
      }
    } else if (backupCreated && !originalRemoved) {
      try {
        unlinkSync(backup)
        backupCreated = false
      } catch {
      }
    }
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
    }
    if (restoreError) {
      throw new AggregateError([replaceError, restoreError], `替换文件失败且原文件恢复失败，备份保留在: ${backup}`)
    }
    throw replaceError
  }
  if (backupCreated) {
    try {
      unlinkSync(backup)
    } catch {
    }
  }
}
