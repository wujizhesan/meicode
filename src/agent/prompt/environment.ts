import type { ToolContext } from '../../tools/index.ts'

export function buildEnvironmentInfo(ctx: ToolContext): string {
  const date = new Date().toISOString().slice(0, 10)
  return `当前工作目录：${ctx.cwd}\n当前日期：${date}`
}
