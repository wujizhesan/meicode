import type { Provider } from '../provider/types.ts'
import type { Tool, ToolContext, ToolResult, ToolRegistry } from '../tools/index.ts'
import type { SubAgentManager } from './manager.ts'
import type { SpawnRequest } from './types.ts'

export function createSpawnAgentTool(manager: SubAgentManager, opts: { provider: Provider; registry: ToolRegistry }): Tool {
  return {
    name: 'spawn_agent',
    description:
      '启动子 Agent 执行子任务。type=defined 用预定义角色（空白上下文，角色列表见对话上下文的「可用子 Agent 角色」段）；type=fork 继承当前对话历史与工具集。隔离方式由角色 frontmatter 的 isolation: worktree 字段决定（无需传参数）。任务完成后结果异步回流主对话。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'defined（角色启动）或 fork（继承历史）' },
        role: { type: 'string', description: 'defined 时的角色名（如 code-reviewer）' },
        prompt: { type: 'string', description: '给子 Agent 的任务描述' },
        async: { type: 'boolean', description: '是否直接后台执行（可选，fork 强制后台）' },
      },
      required: ['type', 'prompt'],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const type = args.type === 'fork' ? 'fork' : 'defined'
      const prompt = String(args.prompt ?? '')
      if (!prompt) return { success: false, output: '', error: '缺少参数 prompt' }

      const req: SpawnRequest = {
        type,
        role: typeof args.role === 'string' ? args.role : undefined,
        prompt,
        async: args.async === true,
      }
      const result = await manager.spawn(req, { provider: opts.provider, registry: opts.registry, ctx })
      if (result.async) {
        return { success: true, output: `子任务已提交后台（任务ID: ${result.id}），完成后结果会回流到对话` }
      }
      return {
        success: true,
        output: result.syncResult ?? `子任务完成（任务ID: ${result.id}）`,
      }
    },
  }
}

export { SubAgentManager } from './manager.ts'
export { SubAgentStore } from './store.ts'
export { loadAgentRoles, parseAgentFile, agentDirs } from './loader.ts'
export type { AgentRole, SpawnRequest, SubAgentRecord, SubAgentStatus } from './types.ts'
