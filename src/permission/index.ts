import type { PermissionEngineLike } from './types.ts'
import type { Decision, PermissionMode, ToolCallInfo } from './types.ts'
import { matchBlacklist } from './blacklist.ts'
import { matchWarning } from './warnings.ts'
import { isPathAllowed } from './sandbox.ts'
import { join, isAbsolute } from 'node:path'

// 读自由、写锁: read_file 不参与路径沙箱(读项目外目标是合法需求,
// 配合 rootLock 只锁写工具); 写/编辑锁在 worktree 内
const FILE_TOOLS = new Set(['write_file', 'edit_file'])
const EDIT_TOOLS = new Set(['write_file', 'edit_file'])

// 只读命令白名单（保守）：安全查询免确认——模型检查状态/查看信息不弹窗
const READONLY_CMD_RE =
  /^\s*(git\s+(status|log|diff|show|branch|remote|fetch|stash\s+list|rev-parse|config)|dir|ls|type|where|cat|node\s+-v|npm\s+(ls|view|list))\b/i

export interface PermissionConfig {
  cwd: string
  mode: PermissionMode
  engine: PermissionEngineLike
  autoAcceptEdits?: boolean
}

export async function checkPermission(call: ToolCallInfo, cfg: PermissionConfig): Promise<Decision> {
  // ① 黑名单（run_command，硬拦截）
  // 拼接 command + args 全文匹配——模型可把参数拆到 args 数组绕过（shutdown /s /f）
  if (call.name === 'run_command') {
    const command = String(call.args.command ?? '')
    const argList = Array.isArray(call.args.args) ? (call.args.args as unknown[]).map(String) : []
    const full = argList.length > 0 ? `${command} ${argList.join(' ')}` : command
    const hit = matchBlacklist(full)
    if (hit.matched) return { type: 'deny', reason: `黑名单拦截：${hit.desc}` }
    // ①.5 危险命令警告表（16 类）：可能合理但危险——弹窗确认，批准后审批缓存记忆
    const warn = matchWarning(full)
    if (warn.matched) {
      // 已有 allow 规则(用户此前批准过) → 放行
      const rule = cfg.engine.match(call)
      if (rule) return rule.action === 'allow' ? { type: 'allow' } : { type: 'deny', reason: `规则拒绝（${rule.source} 级）` }
      if (cfg.mode === 'permissive') return { type: 'allow' }
      if (cfg.mode === 'strict') return { type: 'deny', reason: `危险命令（strict 模式）: ${warn.warning}` }
      return { type: 'ask', reason: `[危险命令 ${warn.category}] ${warn.warning}` }
    }
    // ①.6 只读命令豁免：git status/log、dir、cat 等安全查询不弹窗（回归发现：
    // 模型检查状态时 git status 也要确认,体验差）。黑名单/警告表之后——危险只读已被拦
    // strict 白名单制除外：未配置规则一律拒绝
    if (READONLY_CMD_RE.test(full)) {
      const rule = cfg.engine.match(call)
      if (rule) return rule.action === 'allow' ? { type: 'allow' } : { type: 'deny', reason: `规则拒绝（${rule.source} 级）` }
      if (cfg.mode === 'strict') return { type: 'deny', reason: 'strict 模式：未配置放行规则' }
      return { type: 'allow' }
    }
  }

  // ② 路径沙箱（文件工具）
  if (FILE_TOOLS.has(call.name)) {
    const target = call.args.path
    if (typeof target === 'string') {
      const allowed = await isPathAllowed(target, cfg.cwd)
      if (!allowed) {
        const rule = cfg.engine.match(call)
        if (rule) return rule.action === 'allow' ? { type: 'allow' } : { type: 'deny', reason: `规则拒绝（${rule.source} 级）` }
        if (cfg.mode === 'permissive') return { type: 'allow' }
        if (cfg.mode === 'strict') return { type: 'deny', reason: '路径越出沙箱（strict 模式）' }
        return { type: 'ask' }
      }
    }
  }

  // Accept Edits：文件编辑工具（write_file/edit_file）豁免 ask（default 档位下不弹窗）
  if (cfg.autoAcceptEdits && EDIT_TOOLS.has(call.name)) {
    const rule = cfg.engine.match(call)
    if (rule) return rule.action === 'allow' ? { type: 'allow' } : { type: 'deny', reason: `规则拒绝（${rule.source} 级）` }
    return { type: 'allow' }
  }

  // ③ 规则逐层裁决
  const rule = cfg.engine.match(call)
  if (rule) return rule.action === 'allow' ? { type: 'allow' } : { type: 'deny', reason: `规则拒绝（${rule.source} 级）` }

  // ④ 模式兜底
  if (cfg.mode === 'strict') return { type: 'deny', reason: 'strict 模式：未配置放行规则' }
  if (cfg.mode === 'permissive') return { type: 'allow' }
  return { type: 'ask' }
}

export function absPath(target: string, cwd: string): string {
  return isAbsolute(target) ? target : join(cwd, target)
}

export type { PermissionMode, Rule, Decision, AskResult, ToolCallInfo } from './types.ts'
export { RuleEngine } from './rules.ts'
export { matchBlacklist } from './blacklist.ts'
export { isPathAllowed, resolveReal } from './sandbox.ts'
