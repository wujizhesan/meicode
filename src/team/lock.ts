import { withFileLock } from '../runtime/file-lock.ts'

export function withLock(lockFile: string, fn: () => void): void {
  withFileLock(lockFile, fn)
}
