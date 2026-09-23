import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { projectStatePath, userStatePath } from '../state-paths.ts'

const MAX_DEPTH = 5
const INCLUDE_RE = /^@include\s+(.+)$/

// 三层指令：项目根 > 项目 .meicode > 用户 ~/.meicode（高优先级在前）
export async function loadInstructions(cwd: string): Promise<string> {
  const layers = [
    { path: join(cwd, 'instructions.md'), label: '项目指令' },
    { path: projectStatePath(cwd, 'instructions.md'), label: '项目级指令' },
    { path: userStatePath('instructions.md'), label: '用户指令' },
  ]

  const parts: string[] = []
  for (const layer of layers) {
    if (!existsSync(layer.path)) continue
    const content = expandIncludes(layer.path, cwd)
    if (content.trim()) {
      parts.push(`### ${layer.label}\n\n${content.trim()}`)
    }
  }
  return parts.join('\n\n---\n\n')
}

// @include 展开：visited 防环、深度限 5、越界拦截
function expandIncludes(file: string, cwd: string, depth = 0, visited = new Set<string>()): string {
  if (depth > MAX_DEPTH || visited.has(file)) return ''
  visited.add(file)

  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return ''
  }

  const lines = content.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(INCLUDE_RE)
    if (!m) {
      out.push(line)
      continue
    }
    const target = m[1].trim().replace(/[<>"']/g, '')
    const resolved = resolve(join(file, '..', target))
    // 越界拦截：必须落在 cwd 内
    if (!resolved.startsWith(cwd + sep) && resolved !== cwd) {
      console.warn(`[指令] @include 越界已跳过: ${target}`)
      continue
    }
    if (visited.has(resolved)) {
      console.warn(`[指令] @include 环路已跳过: ${target}`)
      continue
    }
    if (!existsSync(resolved)) {
      console.warn(`[指令] @include 文件不存在: ${target}`)
      continue
    }
    const expanded = expandIncludes(resolved, cwd, depth + 1, visited)
    if (expanded.trim()) out.push(expanded)
  }
  return out.join('\n')
}
