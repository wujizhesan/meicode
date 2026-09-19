import { parse } from 'yaml'

const FALLBACK = Symbol('fallback')

function simpleValue(value: string): unknown | typeof FALLBACK {
  const trimmed = value.trim()
  if (!trimmed || /\s#/.test(trimmed) || /^(?:null|true|false|~)$/i.test(trimmed)) return FALLBACK
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) return FALLBACK
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    const items = inner.split(',').map((item) => item.trim())
    return items.every((item) => /^[A-Za-z0-9_./*\\-]+$/.test(item)) ? items : FALLBACK
  }
  if (/^["'{>&*!|%@`]/.test(trimmed) || /:\s/.test(trimmed)) return FALLBACK
  return trimmed
}

export function parseFrontmatter<T extends object>(raw: string): T {
  const result: Record<string, unknown> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) return (parse(raw) ?? {}) as T
    const separator = line.indexOf(':')
    if (separator <= 0) return (parse(raw) ?? {}) as T
    const key = line.slice(0, separator)
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return (parse(raw) ?? {}) as T
    const value = simpleValue(line.slice(separator + 1))
    if (value === FALLBACK) return (parse(raw) ?? {}) as T
    result[key] = value
  }
  return result as T
}
