import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { guardPath } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 代码分析工具：JS bundle 解混淆/还原（webcrack 集成,按需 npx,不装依赖）
// 用法：deobfuscate path=<js文件> [out=输出目录,默认 <文件同名>.deobfuscated/]
export const deobfuscateTool: Tool = {
  name: 'deobfuscate',
  description:
    '解混淆 JS bundle（代码分析用，内部调用 webcrack）。path=JS文件 out=输出目录(默认 <同名>.deobfuscated/)。输出还原后的文件与简要报告。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要解混淆的 JS 文件路径' },
      out: { type: 'string', description: '输出目录（默认 <文件同名>.deobfuscated/）' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args.path ?? '')
    if (!rawPath) return { success: false, output: '', error: '缺少参数 path' }
    const target = resolve(ctx.cwd, rawPath)
    const blocked = guardPath(ctx, target, false) // 输入纯读:外部目标可读(核心需求)
    if (blocked) return { success: false, output: '', error: blocked }
    if (!existsSync(target)) return { success: false, output: '', error: `文件不存在: ${target}` }

    // 产物默认落工作目录(外部目标默认产物在外部会被拦);out 参数指定时查围栏(防写绕过)
    const outDir = args.out ? resolve(ctx.cwd, String(args.out)) : join(ctx.cwd, `${basename(target)}.deobfuscated`)
    const outBlocked = guardPath(ctx, outDir)
    if (outBlocked) return { success: false, output: '', error: outBlocked }

    return new Promise<ToolResult>((resolvePromise) => {
      // webcrack 按需下载执行(npx)——首次较慢,之后走 npm 缓存
      const child = spawn('npx', ['-y', 'webcrack', target, '-o', outDir], {
        cwd: ctx.cwd,
        shell: process.platform === 'win32',
      })
      let out = ''
      const timer = setTimeout(() => {
        child.kill()
        resolvePromise({ success: false, output: '', error: 'webcrack 超时(120s)——可能首次下载依赖较慢,重试或检查网络' })
      }, 120000)
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolvePromise({ success: true, output: `解混淆完成 → ${outDir}\n${out.slice(0, 500)}` })
        } else {
          resolvePromise({ success: false, output: '', error: `webcrack 失败(exit ${code}): ${out.slice(0, 300)}` })
        }
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolvePromise({ success: false, output: '', error: `webcrack 启动失败: ${e.message}(需要 Node 环境)` })
      })
    })
  },
}
