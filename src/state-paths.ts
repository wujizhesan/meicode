import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const STATE_DIR_NAME = '.meicode'
export const LEGACY_STATE_DIR_NAME = '.mewcode'

export function resolveStateRoot(base: string): string {
  const root = resolve(base)
  const current = join(root, STATE_DIR_NAME)
  const legacy = join(root, LEGACY_STATE_DIR_NAME)
  if (existsSync(current) || !existsSync(legacy)) return current
  return legacy
}

export function projectStateRoot(cwd = process.cwd()): string {
  return resolveStateRoot(cwd)
}

export function projectStatePath(cwd: string, ...segments: string[]): string {
  return join(projectStateRoot(cwd), ...segments)
}

export function userStateRoot(home = homedir()): string {
  return resolveStateRoot(home)
}

export function userStatePath(...segments: string[]): string {
  return join(userStateRoot(), ...segments)
}
