// 危险命令黑名单：硬编码，不可配置放开。保守原则——只拦明确高危，宁缺毋滥。
interface BlacklistEntry {
  re: RegExp
  desc: string
}

const DANGEROUS_PATTERNS: BlacklistEntry[] = [
  { re: /^\s*rm\s+(-{1,2}[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/i, desc: 'rm 删除根目录' },
  { re: /^\s*(del|erase|rd|rmdir)\s+\/s(\s+\/q)?/i, desc: 'Windows 递归删除' },
  { re: /^\s*format\b/i, desc: '格式化磁盘' },
  { re: /^\s*diskpart(\s|$)/i, desc: '磁盘分区操作' },
  { re: /^\s*reg\s+delete/i, desc: '注册表删除' },
  { re: /^\s*sc\s+delete/i, desc: '服务删除' },
  { re: /^\s*shutdown\b/i, desc: '关机/重启' },
  { re: /^\s*fsutil\s+/i, desc: '文件系统底层操作' },
]

export function matchBlacklist(command: string): { matched: boolean; desc: string } {
  const trimmed = command.trim()
  for (const entry of DANGEROUS_PATTERNS) {
    if (entry.re.test(trimmed)) {
      return { matched: true, desc: entry.desc }
    }
  }
  return { matched: false, desc: '' }
}
