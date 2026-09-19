import { dirname } from 'node:path'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

export function atomicWriteFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, content, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, content, 'utf8')
  }
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(file)
      renameSync(temp, file)
    } catch {
      try {
        unlinkSync(temp)
      } catch {
      }
      throw error
    }
  }
}
