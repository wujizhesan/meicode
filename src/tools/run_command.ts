import { spawn } from 'node:child_process'
import { guardCommand } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { truncateOutput } from './types.ts'

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '执行命令行命令并返回输出（含退出码与输出尾部）。注意：本机是 Windows，shell 是 cmd.exe 不是 bash——Unix 命令（grep/head/tail/wc/sed/strings 等）不可用，请用 Windows 命令：dir/type/findstr/more/where；管道/重定向/多行逻辑易出错，复杂处理（正则提取/JSON 解析/文件分片）一律写 .py 或 .js 脚本文件再 node/python 执行。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      args: { type: 'array', description: '命令参数（可选，建议使用以规避引号问题）', items: { type: 'string' } },
      timeout: { type: 'number', description: '超时毫秒数（可选，默认 30000）' },
    },
    required: ['command'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = args.command as string
    if (!command) return { success: false, output: '', error: '缺少参数 command' }
    const argList = Array.isArray(args.args) ? (args.args as string[]).map(String) : []
    const timeoutMs = typeof args.timeout === 'number' ? args.timeout : (ctx.timeoutMs ?? 30000)
    const commandLine = [command, ...argList].join(' ')
    const blocked = guardCommand(ctx, commandLine)
    if (blocked) return { success: false, output: '', error: blocked }

    return new Promise<ToolResult>((resolve) => {
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], { cwd: ctx.cwd, shell: false })
        : spawn(command, argList, { cwd: ctx.cwd, shell: false })

      let out = ''
      let killed = false
      let cancelled = false
      let settled = false
      const terminate = () => {
        if (process.platform === 'win32' && child.pid) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false })
          } catch {
            // 忽略
          }
        }
        child.kill()
      }
      const timer = setTimeout(() => {
        killed = true
        // Windows 下 kill 只杀 cmd 包装进程,孙进程仍持管道 → close 永不触发。
        // 杀进程树(taskkill /T)+ 兜底 resolve,双保险
        if (process.platform === 'win32' && child.pid) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false })
          } catch {
            // 忽略
          }
        }
        terminate()
        setTimeout(() => {
          if (!settled) {
            settled = true
            ctx.signal?.removeEventListener('abort', onAbort)
            const { output, truncated } = truncateOutput(out)
            resolve({ success: false, output, truncated, error: `命令超时（${timeoutMs}ms）已被终止`, evidence: { commands: [commandLine] } })
          }
        }, 1500)
      }, timeoutMs)

      function onAbort() {
        if (settled) return
        cancelled = true
        clearTimeout(timer)
        terminate()
        setTimeout(() => {
          if (!settled) {
            settled = true
            ctx.signal?.removeEventListener('abort', onAbort)
            const { output, truncated } = truncateOutput(out)
            resolve({ success: false, output, truncated, error: '命令已取消', evidence: { commands: [commandLine] } })
          }
        }, 1500)
      }

      if (ctx.signal?.aborted) {
        onAbort()
      } else {
        ctx.signal?.addEventListener('abort', onAbort, { once: true })
      }

      const sink = (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (Buffer.byteLength(out, 'utf8') > 16384) out = out.slice(-8192)
      }
      child.stdout?.on('data', sink)
      child.stderr?.on('data', sink)

      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        resolve({ success: false, output: '', error: `命令启动失败: ${e.message}`, evidence: { commands: [commandLine] } })
      })

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        const { output, truncated } = truncateOutput(out)
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
