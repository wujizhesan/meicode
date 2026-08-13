import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 轻量文件日志：文件 <cwd>/.mewcode/meicode.log，追加写，磁盘满/权限错静默
// 分级：error（异常）/ warn（可恢复问题）/ info（请求·工具·会话关键事件，频率低无性能问题）
// 环境变量 MEICODE_LOG_LEVEL=error 可关闭 info（默认全开）
let logFile: string | null = null
let minLevel: 'info' | 'warn' | 'error' = 'info'

export function initLogger(cwd: string): void {
  try {
    const dir = join(cwd, '.mewcode')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'meicode.log')
  } catch {
    logFile = null
  }
  if (process.env.MEICODE_LOG_LEVEL === 'error') minLevel = 'error'
}

const LEVEL_ORDER: Record<'info' | 'warn' | 'error', number> = { info: 0, warn: 1, error: 2 }

export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  if (!logFile) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${msg}\n`, 'utf8')
  } catch {
    // 静默：磁盘满/无权限时日志不阻塞主流程
  }
}
