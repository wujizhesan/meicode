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
  const tail = mainHistory.all().slice(-(skill.history ?? 5))
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
  let output = ''
  for await (const ev of agent.events) {
    if (ev.type === 'text') output += ev.text
  }
  await agent.done

  // 补充子会话的工具结果（npm test 等输出在 tool 消息里）
  const toolOut = sub
    .all()
    .filter((m) => m.role === 'tool')
    .map((m) => m.content)
    .join('\n')
  const combined = [output, toolOut].filter(Boolean).join('\n\n---\n\n')
  if (!combined.trim()) return '（子会话未产生输出）'

  // LLM 摘要
  const summaryMsgs: ChatMessage[] = [
    { role: 'system', content: '把下面的执行输出压缩成 200 字以内的中文摘要，保留关键结论与数字。只输出摘要正文。' },
    { role: 'user', content: combined.slice(-8000) },
  ]
  let summary = ''
  for await (const ev of opts.provider.streamChat(summaryMsgs, { thinking: false })) {
    if (ev.type === 'text') summary += ev.text
  }
  return summary.trim() || output.slice(0, 500)
}

export { SkillManager } from './manager.ts'
export { loadAllSkills, parseSkillFile } from './loader.ts'
export type { SkillDef, ActiveSkill, SkillDirs } from './types.ts'
