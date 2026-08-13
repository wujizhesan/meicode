import type { Tool, ToolContext, ToolResult } from './types.ts'

// Elicitation 工具(对齐 Claude Code):agent 主动反问用户
// 信息不足/需要决策时调用——不猜、不问死,拿用户回答继续
// 无交互通道(headless/成员)时返回失败,agent 应降级处理
export const elicitTool: Tool = {
  name: 'elicit',
  description:
    '向用户提问并等待回答(信息不足/需要决策时用,不要猜)。question=问题 options=选项数组(可选,提供后用户可快速选择)。返回用户的回答文本。仅当问题无法从上下文推断时使用,避免打扰。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问的问题' },
      options: { type: 'array', description: '可选答案列表(用户可快速选择)', items: { type: 'string' } },
    },
    required: ['question'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const question = String(args.question ?? '')
    if (!question) return { success: false, output: '', error: '缺少参数 question' }
    const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).filter(Boolean) : []
    if (!ctx.elicit) return { success: false, output: '', error: `[elicit 无交互通道] ${question}` }
    const answer = await ctx.elicit(question, options)
    if (answer === null) return { success: false, output: '', error: '[elicit 用户未回答]' }
    return { success: true, output: `用户回答: ${answer}` }
  },
}
