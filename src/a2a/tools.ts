import { A2aClient } from './client.ts'
import type { A2aAgentConfig } from './config.ts'
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts'
import { truncateOutput } from '../tools/types.ts'

function jsonOutput(value: unknown): ToolResult {
  const truncated = truncateOutput(JSON.stringify(value, null, 2))
  return { success: true, output: truncated.output, ...(truncated.truncated ? { truncated: true } : {}) }
}

export function createA2aTools(configs: A2aAgentConfig[]): Tool[] {
  if (configs.length === 0) return []
  const byName = new Map(configs.map((config) => [config.name, config]))
  const clients = new Map<string, A2aClient>()
  const clientFor = (name: string): A2aClient => {
    const config = byName.get(name)
    if (!config) throw new Error(`未配置 A2A Agent: ${name}`)
    const cached = clients.get(name)
    if (cached) return cached
    const client = new A2aClient(config.url, { authToken: config.token, binding: config.binding })
    clients.set(name, client)
    return client
  }
  const agentSchema = { type: 'string', enum: configs.map((config) => config.name), description: '配置中的远程 Agent 名称' }

  const sendTool: Tool = {
    name: 'a2a_send_message',
    description: '向配置白名单中的远程 A2A Agent 发送任务，并返回任务状态和产物。',
    parameters: {
      type: 'object',
      properties: {
        agent: agentSchema,
        message: { type: 'string', description: '发送给远程 Agent 的任务说明' },
        return_immediately: { type: 'boolean', description: '是否创建任务后立即返回' },
      },
      required: ['agent', 'message'],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const agent = String(args.agent ?? '')
      const message = String(args.message ?? '')
      if (!agent || !message) return { success: false, output: '', error: '缺少 agent 或 message' }
      try {
        const task = await clientFor(agent).sendMessage(message, args.return_immediately === true ? { returnImmediately: true } : undefined, ctx.signal)
        return jsonOutput({ agent, taskId: task.id, status: task.status, artifacts: task.artifacts })
      } catch (error) {
        return { success: false, output: '', error: `A2A 调用失败: ${(error as Error).message}` }
      }
    },
  }

  const getTool: Tool = {
    name: 'a2a_get_task',
    description: '查询配置白名单中远程 A2A Agent 的任务状态和产物。',
    parameters: {
      type: 'object',
      properties: {
        agent: agentSchema,
        task_id: { type: 'string', description: '远程任务 ID' },
        history_length: { type: 'number', description: '最多返回的历史消息数' },
      },
      required: ['agent', 'task_id'],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const agent = String(args.agent ?? '')
      const taskId = String(args.task_id ?? '')
      if (!agent || !taskId) return { success: false, output: '', error: '缺少 agent 或 task_id' }
      try {
        const historyLength = args.history_length === undefined ? undefined : Number(args.history_length)
        return jsonOutput(await clientFor(agent).getTask(taskId, historyLength, ctx.signal))
      } catch (error) {
        return { success: false, output: '', error: `A2A 查询失败: ${(error as Error).message}` }
      }
    },
  }

  const listTool: Tool = {
    name: 'a2a_list_tasks',
    description: '列出配置白名单中远程 A2A Agent 的任务，支持状态筛选和分页。',
    parameters: {
      type: 'object',
      properties: {
        agent: agentSchema,
        context_id: { type: 'string' },
        status: { type: 'string' },
        page_size: { type: 'number' },
        page_token: { type: 'string' },
      },
      required: ['agent'],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const agent = String(args.agent ?? '')
      if (!agent) return { success: false, output: '', error: '缺少 agent' }
      try {
        return jsonOutput(await clientFor(agent).listTasks({
          contextId: typeof args.context_id === 'string' ? args.context_id : undefined,
          status: typeof args.status === 'string' ? args.status : undefined,
          pageSize: args.page_size === undefined ? undefined : Number(args.page_size),
          pageToken: typeof args.page_token === 'string' ? args.page_token : undefined,
        }, ctx.signal))
      } catch (error) {
        return { success: false, output: '', error: `A2A 列表查询失败: ${(error as Error).message}` }
      }
    },
  }

  return [sendTool, getTool, listTool]
}
