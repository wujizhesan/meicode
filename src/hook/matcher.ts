import { minimatch } from 'minimatch'
import type { HookClause, HookCondition } from './types.ts'

// pattern 语法：精确 / !反向 / /re/正则 / *glob
export function matchPattern(value: string, pattern: string): boolean {
  if (pattern.startsWith('!')) return !matchPattern(value, pattern.slice(1))
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(value)
    } catch {
      return false
    }
  }
  if (pattern.includes('*')) return minimatch(value, pattern)
  return value === pattern
}

// 点路径取值：'args.command' → data.args.command
function getPath(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

export function matchClause(data: Record<string, unknown>, clause: HookClause): boolean {
  const value = getPath(data, clause.match)
  if (typeof value !== 'string') return false
  return matchPattern(value, clause.pattern)
}

// all 全部满足 / any 任一满足；二选一
export function matchCondition(data: Record<string, unknown>, cond: HookCondition): boolean {
  if (cond.all) return cond.all.every((c) => matchClause(data, c))
  if (cond.any) return cond.any.some((c) => matchClause(data, c))
  return true // 空条件 = 无条件
}
