import { dirname } from 'node:path'
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function atomicWriteFile(file: string, content: string | Uint8Array): void {
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
  const discardTemp = () => {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
    }
  }
  let replaceError: unknown
  try {
    renameSync(temp, file)
    return
  } catch (error) {
    replaceError = error
  }
  let targetExists = false
  let targetIsFile = false
  try {
    const stats = lstatSync(file)
    targetExists = true
    targetIsFile = !stats.isDirectory()
  } catch {
  }
  // 目标存在但不是普通文件（目录等）：不做任何替换尝试即失败，
  // 绝不能把它移开。旧实现靠 copyFileSync 对目录报错间接达到同样效果。
  if (targetExists && !targetIsFile) {
    discardTemp()
    throw replaceError
  }
  // 回退：把原目标整体移开，再放置新文件。两步都是重命名，失败时不会破坏原目标。
  //
  // 不用「复制出备份 → 删除原文件 → 放置新文件」的写法：删除会让目标名进入
  // 「删除挂起」状态，而该状态下同名文件在句柄关闭前无法再次创建（Windows 上实测如此）。
  // 一旦随后的放置失败，原文件就真的没了——只剩一个 .bak，读取方看到的是空文件。
  // 移开是纯重命名，即使失败也不会改变文件系统状态。
  let movedAside = false
  try {
    if (targetExists) {
      renameSync(file, backup)
      movedAside = true
    }
    renameSync(temp, file)
  } catch (error) {
    replaceError = error
    let restoreError: unknown
    if (movedAside) {
      try {
        if (existsSync(file)) unlinkSync(backup)
        else renameSync(backup, file)
      } catch (restoreFailure) {
        restoreError = restoreFailure
      }
    }
    discardTemp()
    if (restoreError) {
      throw new AggregateError([replaceError, restoreError], `替换文件失败且原文件恢复失败，备份保留在: ${backup}`)
    }
    throw replaceError
  }
  if (movedAside) {
    try {
      unlinkSync(backup)
    } catch {
    }
  }
}
