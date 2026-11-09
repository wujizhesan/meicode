// 危险命令警告表(16 类)：
// 与黑名单不同——这些命令"可能合理"(如私人仓库 force push)，
// 命中时降级为 ask 弹窗确认,批准后由审批缓存记忆,不硬拦截

interface WarningEntry {
  re: RegExp
  category: string
  warning: string
}

const DANGEROUS_WARNINGS: WarningEntry[] = [
  { re: /^\s*git\s+reset\s+--hard/i, category: 'git', warning: 'git reset --hard 将丢弃全部未提交修改' },
  { re: /^\s*git\s+push\s+(--force|-f\b)/i, category: 'git', warning: 'git push --force 会覆盖远端历史(他人提交也可能丢失)' },
  { re: /^\s*git\s+clean\s+-f/i, category: 'git', warning: 'git clean -f 删除所有未跟踪文件' },
  { re: /^\s*git\s+checkout\s+\./i, category: 'git', warning: 'git checkout . 丢弃工作区全部修改' },
  { re: /^\s*git\s+restore\s+\./i, category: 'git', warning: 'git restore . 丢弃工作区全部修改' },
  { re: /^\s*git\s+stash\s+(drop|clear)/i, category: 'git', warning: 'git stash drop/clear 删除 stash(可能含未完成成果)' },
  { re: /^\s*git\s+branch\s+-D/i, category: 'git', warning: 'git branch -D 强制删除分支' },
  { re: /^\s*git\s+--no-verify/i, category: 'git', warning: 'git --no-verify 跳过 commit/push 钩子(绕过检查)' },
  { re: /^\s*git\s+commit\s+--amend/i, category: 'git', warning: 'git commit --amend 改写已提交信息' },
  { re: /^\s*git\s+remote\s+(add|remove|rename|set-url|prune|update)\b/i, category: 'git', warning: 'git remote 修改远端配置或远端跟踪状态' },
  { re: /^\s*git\s+config\b/i, category: 'git', warning: 'git config 可能修改仓库或全局 Git 配置' },
  { re: /^\s*(rm|Remove-Item)\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)+/i, category: 'file', warning: 'rm -r 递归删除目录' },
  { re: /^\s*(rm|Remove-Item)\s+(-[a-zA-Z]*f[a-zA-Z]*)/i, category: 'file', warning: 'rm -f 强制删除文件' },
  { re: /^\s*rm\s+-rf/i, category: 'file', warning: 'rm -rf 递归强制删除' },
  { re: /^\s*(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)/i, category: 'sql', warning: 'SQL DROP/TRUNCATE 删除表/清空表' },
  { re: /^\s*DELETE\s+FROM/i, category: 'sql', warning: 'SQL DELETE FROM 删除数据(注意 WHERE 条件)' },
  { re: /^\s*kubectl\s+delete/i, category: 'k8s', warning: 'kubectl delete 删除 K8s 资源' },
  { re: /^\s*terraform\s+destroy/i, category: 'infra', warning: 'terraform destroy 销毁整个基础设施' },
]

export function matchWarning(command: string): { matched: boolean; category: string; warning: string } {
  const trimmed = command.trim()
  for (const entry of DANGEROUS_WARNINGS) {
    if (entry.re.test(trimmed)) {
      return { matched: true, category: entry.category, warning: entry.warning }
    }
  }
  return { matched: false, category: '', warning: '' }
}
