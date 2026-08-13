import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execSync } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 抓包工具(data-expert 用):mitmdump 后台代理 + 请求日志解析
// 注: mitmdump -w flow 文件在 Windows 被杀时不 flush(0 字节)——改用 stdout 日志
// (实时写入),list 解析文本日志
// action=start 启动代理(默认端口 8080,日志写 <cwd>/.mewcode/captures/<ts>.log)
// action=stop 停止;action=list 解析最近日志,列出请求(方法/URL/状态/响应大小)
const RUNNING = new Map<string, { pid: number; logFile: string }>()

function lastLogFile(): string | null {
  const dir = join(process.cwd(), '.mewcode', 'captures')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.log')).sort()
  return files.length ? join(dir, files[files.length - 1]) : null
}

export const mitmCaptureTool: Tool = {
  name: 'mitm_capture',
  description:
    '抓包工具(数据获取用)。action=start 启动 mitmdump 代理(port=端口,默认 8080);stop 停止;list 解析最近流量文件列出请求(方法/URL/状态/响应长度);flows 显示指定序号的请求详情。目标需配置代理到本机端口并安装 mitm 证书。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'start / stop / list / flows' },
      port: { type: 'number', description: '代理端口(start 用,默认 8080)' },
      index: { type: 'number', description: 'flows 用:请求序号(0 起)' },
    },
    required: ['action'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? '')
    const port = typeof args.port === 'number' ? args.port : 8080

    if (action === 'start') {
      const dir = join(process.cwd(), '.mewcode', 'captures')
      mkdirSync(dir, { recursive: true })
      const logFile = join(dir, `${Date.now()}.log`)
      // stdout 重定向到日志文件(实时写入,无 -w 的 flush 问题)
      const logFd = openSync(logFile, 'w')
      // 不能加 -q:quiet 会连请求日志一起静默,list 将无内容
      const child = spawn('mitmdump', ['-p', String(port)], {
        cwd: ctx.cwd,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        shell: false,
      })
      child.unref()
      // 等待端口就绪(最多 5s),并检测启动失败(端口占用等——日志会出现 exiting)
      let ok = false
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const log = readFileSync(logFile, 'utf8')
          if (log.includes('exiting') || log.includes('failed to listen')) {
            closeSync(logFd)
            return { success: false, output: '', error: `mitmdump 启动失败: ${log.split('\n')[1]?.slice(0, 150) ?? log.slice(0, 150)}` }
          }
        } catch {
          // 日志还没写入
        }
        try {
          execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: 'pipe' })
          ok = true
          break
        } catch {
          // 继续等
        }
      }
      if (!ok) {
        closeSync(logFd)
        return { success: false, output: '', error: `mitmdump 端口 ${port} 5s 内未就绪(可能被占用)` }
      }
      RUNNING.set(`${port}`, { pid: child.pid ?? -1, logFile })
      return {
        success: true,
        output: `mitmdump 已启动(端口 ${port})\n请求日志: ${logFile}\n目标需: 代理指向 127.0.0.1:${port} + 安装 mitm 证书(mitm.it)`,
      }
    }

    if (action === 'stop') {
      const rec = RUNNING.get(`${port}`)
      if (!rec) return { success: false, output: '', error: `端口 ${port} 没有运行中的代理` }
      try {
        process.kill(rec.pid)
      } catch {
        // 已退出
      }
      RUNNING.delete(`${port}`)
      return { success: true, output: `已停止(端口 ${port}),日志: ${rec.logFile}` }
    }

    if (action === 'list' || action === 'flows') {
      const logFile = lastLogFile()
      if (!logFile) return { success: false, output: '', error: '没有捕获日志(先 start)' }
      try {
        const raw = readFileSync(logFile, 'utf8')
        // 解析 mitmdump 日志: "127.0.0.1:port: GET http://url" 与 "<< 200 OK 12b"
        const lines = raw.split('\n').filter(Boolean)
        const requests: string[] = []
        let current = ''
        for (const l of lines) {
          // 日志格式: "127.0.0.1:61869: GET http://url" (IP 含点号,不能 \w 匹配)
          const m = l.match(/:\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT)\s+(\S+)/)
          if (m) {
            current = m[2].trim()
            requests.push(`${m[1]} ${m[2].trim()}`)
          } else {
            const resp = l.match(/<< (\d{3})[^\d]*(\d+)b$/)
            if (resp && current && requests.length) {
              requests[requests.length - 1] += ` -> ${resp[1]} (${resp[2]}B)`
              current = ''
            }
          }
        }
        if (action === 'flows') {
          const idx = typeof args.index === 'number' ? args.index : 0
          return { success: true, output: requests[idx] ?? `无序号 ${idx} 的请求(共 ${requests.length} 条)` }
        }
        return { success: true, output: requests.length ? `捕获 ${requests.length} 条请求:\n${requests.slice(0, 60).join('\n')}` : '(无请求记录)' }
      } catch (e) {
        return { success: false, output: '', error: `解析日志失败: ${(e as Error).message.slice(0, 200)}` }
      }
    }

    return { success: false, output: '', error: `未知 action: ${action}(start/stop/list/flows)` }
  },
}
