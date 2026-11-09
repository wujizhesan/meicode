import { resolve } from 'node:path'

export function resolveShotDiffOutputPath(args: Record<string, unknown>, cwd: string): string {
  const targetPath = resolve(cwd, String(args.target ?? ''))
  return args.out ? resolve(cwd, String(args.out)) : `${targetPath}.diff.png`
}

export function shotDiffOutputRuleValue(args: Record<string, unknown>): string {
  return args.out ? String(args.out) : `${String(args.target ?? '')}.diff.png`
}
