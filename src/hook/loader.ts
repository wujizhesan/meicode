import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { INTERCEPT_EVENTS } from './types.ts'
import type { HookAction, HookEventName, HookRule } from './types.ts'

const VALID_EVENTS = new Set<HookEventName>([
  'session_start', 'session_end', 'round_start', 'round_end',
  'message', 'tool_before', 'tool_after', 'app_start', 'app_exit',
])

function validateAction(action: unknown): action is HookAction {
  if (!action || typeof action !== 'object') return false
  const a = action as Record<string, unknown>
  if (a.type === 'command') return typeof a.command === 'string'
  if (a.type === 'inject_prompt') return typeof a.content === 'string'
  if (a.type === 'http') return typeof a.url === 'string'
  if (a.type === 'subagent') return typeof a.name === 'string'
  return false
}

function parseRule(raw: Record<string, unknown>): HookRule | null {
  const event = raw.event
  if (typeof event !== 'string' || !VALID_EVENTS.has(event as HookEventName)) {
    console.warn(`[Hook] 非法事件跳过: ${String(event)}`)
    return null
  }
  if (!validateAction(raw.action)) {
    console.warn(`[Hook] 动作无效跳过（event=${event}）`)
    return null
  }
  if (raw.async === true && INTERCEPT_EVENTS.has(event as HookEventName)) {
    console.warn(`[Hook] ${event} 不允许 async，规则跳过`)
    return null
  }
  return {
    event: event as HookEventName,
    ...(raw.if && typeof raw.if === 'object' ? { if: raw.if as HookRule['if'] } : {}),
    action: raw.action as HookAction,
    ...(raw.once === true ? { once: true } : {}),
    ...(raw.async === true ? { async: true } : {}),
  }
}

// 加载项目 + 用户 hooks.yaml（项目覆盖用户同名 index——按数组顺序合并）
export function loadHooks(cwd: string): { rules: HookRule[]; skipped: number } {
  const files = [
    join(homedir(), '.mewcode', 'hooks.yaml'),
    join(cwd, '.mewcode', 'hooks.yaml'),
  ]
  const rules: HookRule[] = []
  let skipped = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    let parsed: { hooks?: unknown }
    try {
      parsed = parse(readFileSync(file, 'utf8')) ?? {}
    } catch (e) {
      console.warn(`[Hook] 解析失败跳过: ${file}（${(e as Error).message}）`)
      skipped++
      continue
    }
    if (!Array.isArray(parsed.hooks)) continue
    for (const item of parsed.hooks) {
      if (item && typeof item === 'object') {
        const rule = parseRule(item as Record<string, unknown>)
        if (rule) rules.push(rule)
        else skipped++
      }
    }
  }
  return { rules, skipped }
}
