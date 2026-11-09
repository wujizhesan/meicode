import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { HookAction } from './types.ts'

const DEFAULT_TIMEOUT = 10000 // Hook 命令默认 10s 超时

// 执行 command 动作；返回输出（用于日志）
export function runCommandAction(command: string, cwd: string, timeoutMs: number, env?: Record<string, string>, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.resolve('')
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, shell: false, windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, ...env } })
      : spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, ...env } })
    let out = ''
    let settled = false
    const sink = (chunk: Buffer) => {
      if (!settled && out.length < 500) out += chunk.toString('utf8').slice(0, 500 - out.length)
    }
    child.stdout?.on('data', sink)
    child.stderr?.on('data', sink)
    const finish = (output: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(output)
    }
    const terminate = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') {
        try {
          const taskkill = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe')
          const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
          killer.once('error', () => { child.kill() })
          killer.once('close', (code) => { if (code !== 0) child.kill() })
        } catch {
          child.kill()
        }
      } else {
        try { process.kill(-child.pid, 'SIGTERM') }
        catch { child.kill() }
      }
    }
    const onAbort = () => {
      if (settled) return
      terminate()
      finish(out)
    }
    const timer = setTimeout(() => {
      terminate()
      finish(out)
    }, timeoutMs)
    child.once('close', () => finish(out))
    child.once('error', (e) => finish(`启动失败: ${e.message}`))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

// HTTP 动作：fire-and-forget，失败仅日志
export function runHttpAction(action: Extract<HookAction, { type: 'http' }>, signal?: AbortSignal): void {
  if (signal?.aborted) return
  void fetch(action.url, {
    signal,
    method: action.method ?? 'POST',
    ...(action.headers ? { headers: action.headers } : {}),
    ...(action.body !== undefined ? { body: action.body } : {}),
  }).catch((e) => {
    if (signal?.aborted) return
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
