import { resolve } from 'node:path'

export function resolveBrowserShotPath(args: Record<string, unknown>, cwd: string): string | null {
  const path = String(args.path ?? '')
  return path ? resolve(cwd, path) : null
}

export function browserRuleValue(args: Record<string, unknown>): string {
  const action = String(args.action ?? '')
  return action === 'shot' ? `shot:${String(args.path ?? '')}` : action
}
