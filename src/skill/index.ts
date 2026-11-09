import type { JsonSchema, Tool, ToolContext, ToolResult } from '../tools/index.ts'
import { ToolRegistry } from '../tools/registry.ts'
import type { Provider, ChatMessage } from '../provider/types.ts'
import { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import type { SkillManager } from './manager.ts'
import type { SkillDef } from './types.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import { ContextManager, spillBatch } from '../context/index.ts'
import { createRuntimeId } from '../runtime/ids.ts'
import { disposeBrowserScope } from '../tools/browser.ts'

const skillToolManagers = new WeakMap<Tool, SkillManager>()

export class SkillRunError extends Error {
  readonly stage: 'execution' | 'summary'
  readonly output: string

  constructor(stage: 'execution' | 'summary', message: string, output = '') {
    super(message)
    this.name = 'SkillRunError'
    this.stage = stage
    this.output = output.trim().slice(-500)
  }
}

// 系统级工具：加载 Skill（不受白名单约束）
export function createLoadSkillTool(manager: SkillManager): Tool {
  const tool: Tool = {
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
  skillToolManagers.set(tool, manager)
  return tool
}

export function createSkillScope(source: ToolRegistry, manager?: SkillManager): { registry: ToolRegistry; skillManager: SkillManager | undefined } {
  const loadSkillTool = source.get('load_skill')
  const skillManager = (manager ?? (loadSkillTool ? skillToolManagers.get(loadSkillTool) : undefined))?.createScope()
  const registry = new ToolRegistry()
  for (const tool of source.list()) {
    registry.register(tool.name === 'load_skill' && skillManager ? createLoadSkillTool(skillManager) : tool)
  }
  if (skillManager && !loadSkillTool) registry.register(createLoadSkillTool(skillManager))
  return { registry, skillManager }
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

interface IsolatedRunOptions {
  provider: Provider
  registry: ToolRegistry
  ctx: ToolContext
  signal?: AbortSignal
  systemPrompt: string
  toolsOverride?: { type: 'function'; function: { name: string; description: string; parameters: JsonSchema } }[] | null
  skillManager?: SkillManager
}

export async function runIsolated(
  skill: SkillDef,
  mainHistory: History,
  opts: IsolatedRunOptions,
): Promise<string> {
  return runIsolatedScope(skill, mainHistory, opts, [])
}

async function runIsolatedScope(
  skill: SkillDef,
  mainHistory: History,
  opts: IsolatedRunOptions,
  ancestors: readonly string[],
): Promise<string> {
  opts.signal?.throwIfAborted()
  const { registry, skillManager } = createSkillScope(opts.registry, opts.skillManager)
  const skillTools = skill.tools === undefined ? null : new Set([...skill.tools, 'load_skill'])
  const resolveRequestOptions = () => {
    const activeTools = skillManager?.activeToolNames()
    const activeNames = activeTools == null ? null : new Set([...activeTools, 'load_skill'])
    const activePrompt = skillManager?.activePrompt() ?? ''
    return {
      toolsOverride: (opts.toolsOverride ?? registry.toOpenAITools())
        .filter((tool) => (!skillTools || skillTools.has(tool.function.name)) && (!activeNames || activeNames.has(tool.function.name))),
      extraSystemMessages: activePrompt ? [activePrompt] : [],
    }
  }
  const generatedTools: ChatMessage[] = []
  let collecting = false
  const sub = new class extends History {
    override push(message: ChatMessage): void {
      super.push(message)
      if (collecting && message.role === 'tool') generatedTools.push(message)
    }
  }()
  const historyCount = skill.history ?? 5
  const tail = historyCount === 0 ? [] : mainHistory.view().slice(-historyCount)
  for (const m of tail) sub.push(m)
  collecting = true
  const budget = opts.ctx.contextBudget?.()
  const agentId = createRuntimeId('agent')
  const contextManager = new ContextManager({
    provider: opts.provider, history: sub, cwd: opts.ctx.cwd,
    window: budget?.window ?? 131072, autoMargin: budget?.autoMargin, manualMargin: budget?.manualMargin,
    hooks: opts.ctx.hooks, sessionId: opts.ctx.sessionId, agentId,
  })
  const childContext: ToolContext = {
    ...opts.ctx,
    agentId,
    permission: opts.ctx.permission ? { ...opts.ctx.permission } : undefined,
    contextBudget: () => contextManager.snapshot(),
    setRequestOverhead: (tokens) => contextManager.setRequestOverhead(tokens),
    beforeRequest: (mode, signal, options) => contextManager.beforeRequest(mode, signal, options),
    afterRequest: (usage, count, overhead) => contextManager.afterRequest(usage, count, overhead),
    spill: (results) => spillBatch(results, opts.ctx.cwd),
  }
  // 独立会话：Skill 指令作为 system，8 轮上限
  try {
    const agent = runAgent({
      provider: opts.provider,
      history: sub,
      registry,
      ctx: childContext,
      signal: opts.signal,
      maxIterations: 8,
      mode: 'full',
      systemPrompt: `${opts.systemPrompt}\n\n${skill.content}`,
      unknownToolLimit: 2,
      resolveRequestOptions,
    })
    const outputParts: string[] = []
    for await (const ev of agent.events) {
      if (ev.type === 'text') outputParts.push(ev.text)
    }
    const result = await agent.done
    opts.signal?.throwIfAborted()
    if (result.reason === 'cancelled') throw new DOMException('Skill 已取消', 'AbortError')

    // 补充子会话的工具结果（npm test 等输出在 tool 消息里）
    if (result.reason !== 'complete') {
      const reason = result.errorMessage ?? {
        error: '模型请求失败',
        max_iterations: `达到迭代上限（${result.rounds} 轮）`,
        unknown_tool: '连续调用未知工具，已停止',
        tool_failures: '工具连续失败，已停止',
        tool_repeat: '重复调用相同工具，已停止',
      }[result.reason]
      throw new SkillRunError('execution', reason, buildSummaryTail(generatedTools, outputParts.join('')))
    }
    const lineage = [...ancestors, skill.name]
    const executed = new Set<string>()
    while (!opts.signal?.aborted) {
      const nested = skillManager?.takeNextIsolated()
      if (!nested) break
      if (executed.has(nested.name)) continue
      executed.add(nested.name)
      let message: string
      try {
        if (lineage.includes(nested.name) || lineage.length >= 8) throw new Error('独立 Skill 嵌套循环或层数过多')
        const summary = await runIsolatedScope(nested, sub, {
          ...opts,
          registry,
          ctx: childContext,
          skillManager,
          toolsOverride: resolveRequestOptions().toolsOverride,
        }, lineage)
        opts.signal?.throwIfAborted()
        message = `[Skill ${nested.name} 结果] ${summary}`
      } catch (error) {
        opts.signal?.throwIfAborted()
        const summaryFailed = error instanceof SkillRunError && error.stage === 'summary'
        const detail = error instanceof Error ? error.message : String(error)
        const partial = error instanceof SkillRunError && error.output ? `\n部分输出：${error.output}` : ''
        message = `[Skill ${nested.name} 结果] ${summaryFailed ? '执行已完成，但摘要失败' : '执行失败'}：${detail}${partial}`
      }
      sub.push({ role: 'system', content: message })
      outputParts.push(`\n${message}`)
    }
    opts.signal?.throwIfAborted()
    const output = outputParts.join('')
    const summaryTail = buildSummaryTail(generatedTools, output)
    if (!/\S/.test(summaryTail) && !/\S/.test(output) && !generatedTools.some((message) => /\S/.test(message.content))) {
      return '（子会话未产生输出）'
    }

    // LLM 摘要
    const summaryMsgs: ChatMessage[] = [
      { role: 'system', content: '把下面的执行输出压缩成 200 字以内的中文摘要，保留关键结论与数字。只输出摘要正文。' },
      { role: 'user', content: summaryTail },
    ]
    try {
      const summary = await resolveOnAbort(async () => {
        opts.signal?.throwIfAborted()
        const summaryParts: string[] = []
        for await (const ev of opts.provider.streamChat(summaryMsgs, { thinking: false, signal: opts.signal })) {
          opts.signal?.throwIfAborted()
          if (ev.type === 'text') summaryParts.push(ev.text)
          else if (ev.type === 'error') throw new Error(ev.message)
        }
        opts.signal?.throwIfAborted()
        return summaryParts.join('')
      }, opts.signal, '')
      opts.signal?.throwIfAborted()
      if (!summary.trim()) throw new Error('摘要返回为空')
      return summary.trim()
    } catch (error) {
      opts.signal?.throwIfAborted()
      throw new SkillRunError('summary', error instanceof Error ? error.message : String(error), summaryTail)
    }
  } finally {
    skillManager?.clear()
    await disposeBrowserScope(childContext, opts.signal)
    childContext.hooks?.clearAgent(childContext.sessionId, agentId)
  }
}

export { SkillManager } from './manager.ts'
export { loadAllSkills, parseSkillFile } from './loader.ts'
export type { SkillDef, ActiveSkill, SkillDirs } from './types.ts'
