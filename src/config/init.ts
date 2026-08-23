import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ConfigInitResult {
  path: string
  created: boolean
}

export function initializeConfig(examplePath: string, targetPath: string): ConfigInitResult {
  if (existsSync(targetPath)) return { path: targetPath, created: false }
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(examplePath, targetPath)
  return { path: targetPath, created: true }
}
