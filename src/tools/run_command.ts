import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { guardCommand, MAX_RESULT_BYTES } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const TRUNCATED_SUFFIX = '\n…[结果已截断]'
const MAX_TIMEOUT_MS = 2_147_483_647

function tailUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  while ((bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

function displayArgument(value: string): string {
  return /^[A-Za-z0-9_./:\\-]+$/.test(value) ? value : JSON.stringify(value)
}

function resolveWindowsBatch(command: string, cwd: string): string | null {
  if (process.platform !== 'win32') return null
  const extension = extname(command).toLowerCase()
  if (extension && extension !== '.cmd' && extension !== '.bat') return null
  const pathLike = isAbsolute(command) || /[\\/:]/.test(command)
  const directories = pathLike ? [''] : [cwd, ...(process.env.PATH ?? '').split(delimiter)]
  const suffixes = extension ? [''] : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.toLowerCase())
    .filter((value) => ['.com', '.exe', '.bat', '.cmd'].includes(value))
  for (const directory of directories) {
    const base = pathLike
      ? (isAbsolute(command) ? command : resolvePath(cwd, command))
      : resolvePath(cwd, directory.replace(/^"|"$/g, ''), command)
    for (const suffix of suffixes) {
      const candidate = base + suffix
      try {
        if (!statSync(candidate).isFile()) continue
      } catch {
        continue
      }
      const foundExtension = extname(candidate).toLowerCase()
      return foundExtension === '.cmd' || foundExtension === '.bat' ? candidate : null
    }
  }
  return null
}

function batchCommandLine(script: string, args: string[]): string | null {
  if ([script, ...args].some((value) => /["%!^\r\n\0]/.test(value))) return null
  const quoted = args.map((value) => `"${value.replace(/\\+$/, (slashes) => slashes + slashes)}"`).join(' ')
  return `""${script}" ${quoted}"`
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '执行命令行命令并返回输出（含退出码与输出尾部）。注意：本机是 Windows，shell 是 cmd.exe 不是 bash——Unix 命令（grep/head/tail/wc/sed/strings 等）不可用，请用 Windows 命令：dir/type/findstr/more/where；管道/重定向/多行逻辑易出错，复杂处理（正则提取/JSON 解析/文件分片）一律写 .py 或 .js 脚本文件再 node/python 执行。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      args: { type: 'array', description: '命令参数（可选，建议使用以保留参数边界；Windows .cmd/.bat 参数不能包含引号、%、!、^ 或换行）', items: { type: 'string' } },
      timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: '超时毫秒数（可选，默认 30000）' },
    },
    required: ['command'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = args.command as string
    if (!command) return { success: false, output: '', error: '缺少参数 command' }
    const argList = Array.isArray(args.args) ? (args.args as string[]).map(String) : []
    const timeoutMs = args.timeout === undefined ? (ctx.timeoutMs ?? 30000) : args.timeout
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return { success: false, output: '', error: `参数 timeout 必须是 1 到 ${MAX_TIMEOUT_MS} 的整数毫秒数` }
    }
    const commandLine = [command, ...argList.map(displayArgument)].join(' ')
    const blocked = guardCommand(ctx, [command, ...argList].join(' '))
    if (blocked) return { success: false, output: '', error: blocked }

    const batch = argList.length > 0 ? resolveWindowsBatch(command, ctx.cwd) : null
    const batchLine = batch ? batchCommandLine(batch, argList) : null
    if (batch && batchLine === null) {
      return { success: false, output: '', error: 'Windows .cmd/.bat 参数包含无法安全传递的字符（引号、%、!、^ 或换行）' }
    }

    return new Promise<ToolResult>((resolve) => {
      const child = batchLine
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', batchLine], {
          cwd: ctx.cwd, shell: false, windowsHide: true, windowsVerbatimArguments: true,
        })
        : argList.length > 0
          ? spawn(command, argList, { cwd: ctx.cwd, shell: false, windowsHide: true })
        : process.platform === 'win32'
          ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd: ctx.cwd, shell: false, windowsHide: true })
          : spawn('/bin/sh', ['-c', command], { cwd: ctx.cwd, shell: false })

      let out = ''
      let killed = false
      let cancelled = false
      let settled = false
      let dropped = false
      let decodersEnded = false
      let terminationRequested = false
      let fallbackTimer: NodeJS.Timeout | undefined
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      const append = (value: string) => {
        if (!value) return
        const combined = out + value
        if (Buffer.byteLength(combined, 'utf8') > MAX_RESULT_BYTES) {
          out = tailUtf8(combined, MAX_RESULT_BYTES)
          dropped = true
        } else {
          out = combined
        }
      }
      const finishOutput = () => {
        if (!decodersEnded) {
          decodersEnded = true
          append(stdoutDecoder.end())
          append(stderrDecoder.end())
        }
        return dropped
          ? { output: tailUtf8(out, MAX_RESULT_BYTES - Buffer.byteLength(TRUNCATED_SUFFIX, 'utf8')) + TRUNCATED_SUFFIX, truncated: true }
          : { output: out, truncated: false }
      }
      const terminate = () => {
        if (terminationRequested) return
        terminationRequested = true
        if (process.platform === 'win32' && child.pid) {
          try {
            const taskkill = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe')
            const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
            killer.once('error', () => { child.kill() })
            killer.once('close', () => { child.kill() })
          } catch {
            child.kill()
          }
        } else {
          child.kill()
        }
      }
      const scheduleFallback = () => {
        if (fallbackTimer) return
        fallbackTimer = setTimeout(() => {
          if (settled) return
          settled = true
          ctx.signal?.removeEventListener('abort', onAbort)
          const { output, truncated } = finishOutput()
          resolve({
            success: false,
            output,
            truncated,
            error: cancelled ? '命令已取消' : `命令超时（${timeoutMs}ms）已被终止`,
            evidence: { commands: [commandLine] },
          })
        }, 1500)
      }
      const timer = setTimeout(() => {
        killed = true
        terminate()
        scheduleFallback()
      }, timeoutMs)

      function onAbort() {
        if (settled) return
        cancelled = true
        clearTimeout(timer)
        terminate()
        scheduleFallback()
      }

      if (ctx.signal?.aborted) {
        onAbort()
      } else {
        ctx.signal?.addEventListener('abort', onAbort, { once: true })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (!settled) append(stdoutDecoder.write(chunk))
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (!settled) append(stderrDecoder.write(chunk))
      })

      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (fallbackTimer) clearTimeout(fallbackTimer)
        ctx.signal?.removeEventListener('abort', onAbort)
        resolve({ success: false, output: '', error: `命令启动失败: ${e.message}`, evidence: { commands: [commandLine] } })
      })

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (fallbackTimer) clearTimeout(fallbackTimer)
        ctx.signal?.removeEventListener('abort', onAbort)
        const { output, truncated } = finishOutput()
        if (cancelled) {
          resolve({ success: false, output, truncated, error: '命令已取消', evidence: { commands: [commandLine] } })
          return
        }
        if (killed) {
          resolve({ success: false, output, truncated, error: `命令超时（${timeoutMs}ms）已被终止`, evidence: { commands: [commandLine] } })
          return
        }
        if (code === 0) {
          resolve({ success: true, output, truncated, evidence: { commands: [commandLine], exitCode: 0 } })
        } else if (signal) {
          resolve({ success: false, output, truncated, error: `命令被信号 ${signal} 终止`, evidence: { commands: [commandLine] } })
        } else {
          resolve({ success: false, output, truncated, error: `命令退出码 ${code}${out ? '\n--- 输出尾部 ---\n' + output.slice(-500) : ''}`, evidence: { commands: [commandLine], exitCode: code ?? undefined } })
        }
      })
    })
  },
}
