import { spawn } from 'node:child_process'
import type { HookAction } from './types.ts'

const DEFAULT_TIMEOUT = 10000 // Hook 命令默认 10s 超时

// 执行 command 动作；返回输出（用于日志）
export function runCommandAction(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd, shell: false })
      : spawn(command, { cwd, shell: true })
    let out = ''
    const sink = (chunk: Buffer) => {
      out += chunk.toString('utf8')
    }
    child.stdout?.on('data', sink)
    child.stderr?.on('data', sink)
    const timer = setTimeout(() => {
      child.kill()
      // Windows 下 kill 后 close 可能不触发（进程树残留）——超时即 resolve
      resolve(out.slice(0, 500))
    }, timeoutMs)
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.slice(0, 500))
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(`启动失败: ${e.message}`)
    })
  })
}

// HTTP 动作：fire-and-forget，失败仅日志
export function runHttpAction(action: Extract<HookAction, { type: 'http' }>): void {
  void fetch(action.url, {
    method: action.method ?? 'POST',
    ...(action.headers ? { headers: action.headers } : {}),
    ...(action.body !== undefined ? { body: action.body } : {}),
  }).catch((e) => {
    console.warn(`[Hook] HTTP 动作失败: ${(e as Error).message}`)
  })
}

// P12：subagent 动作对接——注入真实 spawn 函数（cli 初始化）
let subagentSpawner: ((role: string) => void) | null = null

export function setSubagentSpawner(fn: (role: string) => void): void {
  subagentSpawner = fn
}

export function runSubagentAction(name: string): void {
  if (subagentSpawner) {
    subagentSpawner(name)
  } else {
    console.warn(`[Hook] subagent 动作未配置 spawner（占位）: ${name}`)
  }
}

export { DEFAULT_TIMEOUT }
