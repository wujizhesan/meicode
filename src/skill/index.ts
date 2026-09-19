import type { JsonSchema, Tool, ToolContext, ToolResult, ToolRegistry } from '../tools/index.ts'
import type { Provider, ChatMessage } from '../provider/types.ts'
import { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import { buildPrompt } from '../agent/prompt/index.ts'
import type { SkillManager } from './manager.ts'
import type { SkillDef } from './types.ts'

// 系统级工具：加载 Skill（不受白名单约束）
export function createLoadSkillTool(manager: SkillManager): Tool {
  return {
    name: 'load_skill',
    description: '加载指定 Skill 的完整指令与专属工具。参数：name（Skill 名，如 commit/review/test）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要加载的 Skill 名' } },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const name = String(args.name ?? '')
      if (!name) return { success: false, output: '', error: '缺少参数 name' }
      const result = manager.activate(name)
      const def = manager.get(name)
      return {
        success: !result.includes('未找到'),
        output: def ? `${result}\n模式: ${def.mode}\n说明: ${def.description}` : result,
      }
    },
  }
}

// 独立模式：开子会话跑 Skill，LLM 摘要回流
export function buildSummaryTail(messages: readonly ChatMessage[], output: string, limit = 8000): string {
  const toolParts: string[] = []
  let toolLength = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'tool') continue
    if (toolParts.length > 0) toolLength++
    toolParts.push(message.content)
    toolLength += message.content.length
    if (toolLength >= limit) break
  }
  const toolOut = toolParts.reverse().join('\n')
  if (!toolOut) return output.slice(-limit)
  if (toolOut.length >= limit) return toolOut.slice(-limit)
  if (!output) return toolOut
  const separator = '\n\n---\n\n'
  const outputLimit = limit - separator.length - toolOut.length
  return `${outputLimit > 0 ? output.slice(-outputLimit) : ''}${separator}${toolOut}`.slice(-limit)
}

export async function runIsolated(
  skill: SkillDef,
  mainHistory: History,
  opts: {
    provider: Provider
    registry: ToolRegistry
    ctx: ToolContext
    systemPrompt: string
    toolsOverride?: { type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }[] | null
  },
): Promise<string> {
  const sub = new History()
  const tail = mainHistory.view().slice(-(skill.history ?? 5))
  for (const m of tail) sub.push(m)
  // 独立会话：Skill 指令作为 system，8 轮上限
  const agent = runAgent({
    provider: opts.provider,
    history: sub,
    registry: opts.registry,
    ctx: opts.ctx,
    maxIterations: 8,
    mode: 'full',
    systemPrompt: `${opts.systemPrompt}\n\n${skill.content}`,
    unknownToolLimit: 2,
    toolsOverride: opts.toolsOverride,
  })
  const outputParts: string[] = []
  for await (const ev of agent.events) {
    if (ev.type === 'text') outputParts.push(ev.text)
  }
  const output = outputParts.join('')
  await agent.done

  // 补充子会话的工具结果（npm test 等输出在 tool 消息里）
  const messages = sub.view()
  const summaryTail = buildSummaryTail(messages, output)
  if (!/\S/.test(summaryTail) && !/\S/.test(output) && !messages.some((message) => message.role === 'tool' && /\S/.test(message.content))) {
    return '（子会话未产生输出）'
  }

  // LLM 摘要
  const summaryMsgs: ChatMessage[] = [
    { role: 'system', content: '把下面的执行输出压缩成 200 字以内的中文摘要，保留关键结论与数字。只输出摘要正文。' },
    { role: 'user', content: summaryTail },
  ]
  const summaryParts: string[] = []
  for await (const ev of opts.provider.streamChat(summaryMsgs, { thinking: false })) {
    if (ev.type === 'text') summaryParts.push(ev.text)
  }
  const summary = summaryParts.join('')
  return summary.trim() || output.slice(0, 500)
}

export { SkillManager } from './manager.ts'
export { loadAllSkills, parseSkillFile } from './loader.ts'
export type { SkillDef, ActiveSkill, SkillDirs } from './types.ts'
