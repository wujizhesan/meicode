// 目录名校验：字符集/长度/段/盘符——防路径遍历
const NAME_RE = /^[a-zA-Z0-9_/-]{1,64}$/

export function validateWorktreeName(name: string): boolean {
  if (!NAME_RE.test(name)) return false
  // 段检查：任一段为 . 或 .. 拒绝
  for (const seg of name.split('/')) {
    if (seg === '.' || seg === '..') return false
  }
  // 绝对路径/盘符
  if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)) return false
  return true
}
