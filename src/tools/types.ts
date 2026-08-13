export interface JsonSchema {
  type: 'object'
  description?: string
  properties?: Record<string, unknown>
  required?: string[]
}

export interface Tool {
  name: string
  description: string
  parameters: JsonSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolResult {
  success: boolean
  output: string
  truncated?: boolean
  error?: string
}

import type { AskResult, PermissionContext, ToolCallInfo } from '../permission/types.ts'
import { resolve, sep } from 'node:path'

export interface ToolContext {
  cwd: string
  // 路径围栏：非空时文件工具禁止写入该根目录之外（团队成员 worktree 隔离）
  rootLock?: string
  // 额外允许写路径（rootLock 外,如报告产出目录 D:\reverse-notes——专家的产出物契约）
  rootLockExtra?: string[]
  timeoutMs?: number
  permission?: PermissionContext
  ask?: (call: ToolCallInfo) => Promise<AskResult>
  // Elicitation(对齐 Claude Code):agent 主动反问用户,拿自由文本回答继续
  elicit?: (question: string, options?: string[]) => Promise<string | null>
  // P7 上下文管理挂钩
  spill?: (results: { content: string }[]) => Promise<{ content: string }[]>
  beforeRequest?: (mode: 'auto' | 'manual') => Promise<void>
  afterRequest?: (usageInputTokens: number, messageCount: number) => void
  // P11 Hook 引擎
  hooks?: import('../hook/engine.ts').HookEngine
}

export const MAX_RESULT_BYTES = 8192

// 路径围栏检查：rootLock 非空时，目标路径必须在根内（resolve 后比较，防 ../ 穿越）
// checkWrite=false 表示只读输入路径——读外部目标是核心需求(同 read_file 无围栏)，
// 纯读工具(extract_strings/dd_extract 输入等)用;写路径(产物/输出)必须查围栏防写绕过
export function guardPath(ctx: ToolContext, target: string, checkWrite = true): string | null {
  if (!ctx.rootLock) return null
  if (!checkWrite) return null
  const resolved = resolve(target)
  const roots = [resolve(ctx.rootLock), ...(ctx.rootLockExtra ?? []).map((r) => resolve(r))]
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + sep)) return null
  }
  return `路径越界: ${target}（只能在工作目录 ${ctx.rootLock} 内操作）`
}

// 命令围栏：rootLock 非空时，命令文本中引用的盘符绝对路径必须在根内
//（防成员用 run_command 绕过写工具围栏改主仓库文件）
const ABS_PATH_RE = /(?<![A-Za-z0-9_\\/.:-])[A-Za-z]:[\\/][^\s'"`<>|&;()]*/g
// 相对路径穿越（cd ..\..\ 或 ..\x）：无盘符，正则查不到，单独拦截
// lookbehind 必须是 token 边界/分隔符（空白/引号/符号/\ /）——排除 '.' 与字母，
// 否则 .\.. 前缀（'..' 前是 '\'）绕过、句尾省略号（hello... 的 .. 后是行尾）误杀
// 无 g 标志：test() 有 lastIndex 状态，交替调用会漏检
const DOTDOT_RE = /(?<=^|[\s"'&|;()\\/])\.\.(?=[\\/\s"'&|;()]|$)/

// 只读命令(同 permission): 侦察/查看外部目标目录需要,不做路径围栏(它们不改文件)
// 白名单只放纯只读无副作用命令;sed(-i 写文件)/find(-exec/-delete)/node(-e 任意执行)不放
// Windows 原生只读命令(finder/more/findstr)与 Unix 常用(ls/cat/head 等,成员在 cmd 里易混用,放行由模型自行适配)
const READONLY_CMD_RE =
  /^\s*(ls|dir|type|cat|where|head|tail|wc|file|stat|du|strings|xxd|od|grep|findstr|more|git\s+(status|log|diff|show|branch|remote|fetch|ls-files|rev-parse)|node\s+-v|npm\s+(ls|view))\b/i

export function guardCommand(ctx: ToolContext, command: string): string | null {
  if (!ctx.rootLock) return null
  // 只读命令豁免——调研/经理要查看外部目标目录(核心需求),只读不改文件
  if (READONLY_CMD_RE.test(command)) return null
  if (DOTDOT_RE.test(command)) {
    return `命令包含相对路径穿越（..），只能在工作目录 ${ctx.rootLock} 内操作。读取外部目标文件请改用 read_file 工具——它不受目录限制`
  }
  const roots = [resolve(ctx.rootLock), ...(ctx.rootLockExtra ?? []).map((r) => resolve(r))]
  for (const m of command.matchAll(ABS_PATH_RE)) {
    const p = m[0].replace(/[\\/]+$/, '')
    const r = resolve(p).toLowerCase()
    if (roots.some((root) => r === root.toLowerCase() || r.startsWith(root.toLowerCase()))) continue
    return `命令引用了工作目录外的绝对路径: ${p}（只能在工作目录 ${ctx.rootLock} 内操作。读取外部目标文件请改用 read_file 工具——它不受目录限制）`
  }
  return null
}

export function truncateOutput(text: string): { output: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_RESULT_BYTES) return { output: text, truncated: false }
  // 按码点截断（Array.from），UTF-16 slice 会切裂 surrogate pair/中文边界
  const chars = Array.from(text)
  let end = chars.length
  while (end > 0) {
    const cut = chars.slice(0, end).join('')
    if (Buffer.byteLength(cut, 'utf8') <= MAX_RESULT_BYTES) {
      return { output: cut + '\n…[结果已截断]', truncated: true }
    }
    end = Math.floor(end * 0.9)
  }
  return { output: '…[结果已截断]', truncated: true }
}
