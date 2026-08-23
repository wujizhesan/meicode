import { realpath } from 'node:fs/promises'
import { join, sep, isAbsolute, dirname } from 'node:path'

// 解析符号链接后的真实路径；文件不存在时对最深已存在祖先 realpath 再拼接
export async function resolveReal(target: string): Promise<string> {
  let current = target
  const suffix: string[] = []
  while (true) {
    try {
      const real = await realpath(current)
      return suffix.length === 0 ? real : join(real, ...suffix.reverse())
    } catch {
      suffix.push(current.split(sep).pop() ?? '')
      const parent = dirname(current)
      if (parent === current) return target
      current = parent
    }
  }
}

export async function isPathAllowed(target: string, cwd: string, extraRoots: string[] = []): Promise<boolean> {
  const absolute = isAbsolute(target) ? target : join(cwd, target)
  const real = await resolveReal(absolute)
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const resolved = normalize(real)
  const roots = await Promise.all([cwd, ...extraRoots].map((root) => resolveReal(root)))
  return roots.map(normalize).some((root) => resolved === root || resolved.startsWith(root + sep))
}
