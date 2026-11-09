import type { Tool } from './types.ts'
import { resolveOnAbort } from './abort.ts'

export const codeIntelTool: Tool = {
  name: 'code_intel',
  description:
    '代码智能(TS/JS 项目): defs=查符号定义位置 file=<文件> sym=<符号名>; refs=查符号引用; diagnostics=查文件诊断(编译错误/警告) file=<文件>。改代码前用 defs 定位、改完用 diagnostics 验证。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'defs / refs / diagnostics' },
      file: { type: 'string', description: '目标文件路径(defs/refs/diagnostics 用)' },
      sym: { type: 'string', description: '符号名(defs/refs 用)' },
      line: { type: 'number', description: '符号所在行(1 起,defs/refs 用,优先于 sym)' },
    },
    required: ['action'],
  },
  async execute(args, ctx) {
    if (ctx.signal?.aborted) return { success: false, output: '', error: '代码智能已取消' }
    const loaded = await resolveOnAbort(() => import('./code_intel.ts'), ctx.signal, null)
    if (!loaded || ctx.signal?.aborted) return { success: false, output: '', error: '代码智能已取消' }
    return loaded.codeIntelTool.execute(args, ctx)
  },
}
