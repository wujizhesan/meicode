import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardPath } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 代码分析工具：从二进制/大文件提取可读字符串（URL/端点/密钥痕迹/协议字段）
// 用法：extract_strings path=<文件> [min_len=6] [max=200] [filter=关键词,逗号分隔]
export const extractStringsTool: Tool = {
  name: 'extract_strings',
  description:
    '从二进制或大文件中提取可读字符串（代码分析用）。path=文件路径 min_len=最短长度(默认6) max=最多输出条数(默认200) filter=关键词过滤(逗号分隔,如 http,api,key)。输出 文件:行号 格式的字符串清单。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径（相对或绝对）' },
      min_len: { type: 'number', description: '最短字符串长度（默认 6）' },
      max: { type: 'number', description: '最多输出条数（默认 200）' },
      filter: { type: 'string', description: '关键词过滤（逗号分隔）' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = String(args.path ?? '')
    if (!rawPath) return { success: false, output: '', error: '缺少参数 path' }
    const target = resolve(ctx.cwd, rawPath)
    const blocked = guardPath(ctx, target, false) // 纯读:外部目标可读(核心需求)
    if (blocked) return { success: false, output: '', error: blocked }

    let buf: Buffer
    try {
      const size = statSync(target).size
      if (size > 200 * 1024 * 1024) return { success: false, output: '', error: `文件过大(${(size / 1024 / 1024).toFixed(0)}MB),上限 200MB` }
      buf = readFileSync(target)
    } catch (e) {
      return { success: false, output: '', error: `读取失败: ${(e as Error).message}` }
    }

    const minLen = typeof args.min_len === 'number' ? Math.max(4, args.min_len) : 6
    const maxOut = typeof args.max === 'number' ? Math.min(1000, Math.max(10, args.max)) : 200
    const filters = typeof args.filter === 'string' && args.filter.trim()
      ? args.filter.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean)
      : []

    // ASCII 可打印串 + UTF-8 中文串
    const found: { s: string; off: number }[] = []
    let i = 0
    let cur: string[] = []
    let curOff = 0
    const flush = () => {
      const s = cur.join('')
      if (s.length >= minLen) found.push({ s, off: curOff })
      cur = []
    }
    while (i < buf.length) {
      const b = buf[i]
      if (b >= 0x20 && b <= 0x7e) {
        if (cur.length === 0) curOff = i
        cur.push(String.fromCharCode(b))
      } else if (b >= 0xc0 && b <= 0xef && i + 2 < buf.length) {
        // UTF-8 多字节(中文等)——尝试解码
        if (cur.length === 0) curOff = i
        cur.push(buf.toString('utf8', i, i + 3))
        i += 2
      } else {
        if (cur.length > 0) flush()
      }
      i++
    }
    if (cur.length > 0) flush()

    // 过滤 + 排序(按长度降序,优先长串——通常更有信息量)
    let list = found
      .filter((f) => f.s.length >= minLen)
      .sort((a, b) => b.s.length - a.s.length)
    if (filters.length > 0) {
      list = list.filter((f) => {
        const lower = f.s.toLowerCase()
        return filters.some((k) => lower.includes(k))
      })
    }
    const capped = list.slice(0, maxOut)
    const lines = capped.map((f) => `@0x${f.off.toString(16)}: ${f.s.slice(0, 200)}`)
    const total = list.length
    return {
      success: true,
      output: lines.length
        ? `提取 ${total} 条(显示 ${lines.length}/${maxOut})，最长优先:\n${lines.join('\n')}`
        : `未提取到长度 ≥${minLen} 的字符串${filters.length ? `(含关键词 ${filters.join('/')})` : ''}`,
      truncated: capped.length < list.length,
    }
  },
}
