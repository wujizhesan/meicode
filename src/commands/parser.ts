import type { ParsedCommand } from './types.ts'

// 斜杠命令解析：'/name args' → { name, args }；非命令/空输入 → null
export function parseCommandLine(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null
  const trimmed = input.trim()
  if (trimmed === '/' || trimmed.length <= 1) return null
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
  if (!rawName) return null
  return { name: rawName.toLowerCase(), args: rest }
}
