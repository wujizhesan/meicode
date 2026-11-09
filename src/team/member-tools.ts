import type { Tool, ToolContext, ToolResult } from '../tools/index.ts'
import type { TeamGroup, TeamMember, TeamTask } from './types.ts'
import { isTeamActorName, parseTaskDependencies, parseTaskMaxAttempts, parseTaskTitle, parseTaskUpdate, TASK_MAX_ATTEMPTS } from './validation.ts'
import { paginateTasks, taskSummary } from './task-page.ts'

export interface MemberToolServices {
  withContext?: (context: ToolContext, operation: () => ToolResult) => ToolResult
  resolveMember: (context: Pick<ToolContext, 'cwd' | 'agentId'>) => { group: TeamGroup; member: TeamMember } | null
  isLeadContext: (context: Pick<ToolContext, 'cwd' | 'agentId'>) => boolean
  listTasks: (groupName: string) => TeamTask[]
  addTask: (groupName: string, title: string, assignee?: string, dependencies?: string[], maxAttempts?: number) => TeamTask
  updateTask: (groupName: string, memberName: string, taskId: string, patch: Record<string, unknown>) => TeamTask | null
  sendMail: (from: string, to: string, body: string) => void
}

export function createMemberTools(services: MemberToolServices): Tool[] {
  const executeWithContext = async (context: ToolContext, operation: () => ToolResult): Promise<ToolResult> => {
    try { return services.withContext ? services.withContext(context, operation) : operation() }
    catch (error) { return { success: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  }
  return [
    {
      name: 'team_task',
      description:
        '团队共享任务操作。action=list 分页查看任务（默认最近 50 条，可按 status 筛选）；get 按 id 查看完整任务；create 创建；update 更新状态和结果。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list / get / create / update' },
          id: { type: 'string', description: '任务 ID（get / update 用）' },
          limit: { type: 'number', description: 'list 每页数量，默认 50，最多 100' },
          cursor: { type: 'string', description: 'list 上一页返回的下一页游标' },
          title: { type: 'string', description: '任务标题（create 用）' },
          assignee: { type: 'string', description: '负责人（create 用）' },
          depends_on: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表（create 用）' },
          max_attempts: { type: 'integer', minimum: 1, maximum: TASK_MAX_ATTEMPTS, description: '最多执行次数（create 用）' },
          status: { type: 'string', description: 'list 的状态筛选，或 update 的新状态' },
          result: { type: 'string', description: '任务结果摘要（update 用）' },
        },
        required: ['action'],
      },
      execute: (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => executeWithContext(context, () => {
        const identity = services.resolveMember(context)
        if (!identity) return { success: false, output: '', error: '无法唯一识别成员身份' }
        const groupName = identity.group.name
        const memberName = identity.member.name
        if (typeof args.action !== 'string') throw new Error('action 必须是字符串')
        const action = args.action
        if (action === 'list') {
          const tasks = services.listTasks(groupName)
          let page: ReturnType<typeof paginateTasks>
          try {
            page = paginateTasks(tasks, args)
          } catch (error) {
            return { success: false, output: '', error: (error as Error).message }
          }
          if (tasks.length === 0) return { success: true, output: '（无任务）' }
          return { success: true, output: JSON.stringify({
            total: page.total,
            matched: page.matched,
            tasks: page.tasks.map(taskSummary),
            next: page.nextCursor === undefined ? null : {
              action: 'list',
              limit: args.limit ?? 50,
              ...(args.status ? { status: args.status } : {}),
              cursor: page.nextCursor,
            },
          }, null, 2) }
        }
        if (action === 'get') {
          const taskId = typeof args.id === 'string' ? args.id : ''
          if (!taskId) return { success: false, output: '', error: '任务 ID 必须是非空字符串' }
          const task = services.listTasks(groupName).find((item) => item.id === taskId)
          return task
            ? { success: true, output: JSON.stringify(task, null, 2) }
            : { success: false, output: '', error: `任务不存在: ${taskId}` }
        }
        if (action === 'create') {
          const title = parseTaskTitle(args.title === undefined ? '未命名' : args.title)
          const assignee = args.assignee === undefined ? memberName : args.assignee
          if (typeof assignee !== 'string' || !isTeamActorName(assignee)) throw new Error('负责人必须是合法成员名')
          const dependencies = parseTaskDependencies(args.depends_on)
          const maxAttempts = parseTaskMaxAttempts(args.max_attempts)
          try {
            const task = services.addTask(
              groupName,
              title,
              assignee,
              dependencies,
              maxAttempts,
            )
            return { success: true, output: `已创建任务 ${task.id}: ${task.title}` }
          } catch (error) {
            return { success: false, output: '', error: (error as Error).message }
          }
        }
        if (action === 'update') {
          if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('任务 ID 必须是非空字符串')
          const taskId = args.id
          const update = parseTaskUpdate(args)
          try {
            const task = services.updateTask(groupName, memberName, taskId, update)
            if (!task) return { success: false, output: '', error: `任务不存在: ${taskId}` }
            return { success: true, output: `任务 ${taskId} 已更新: ${task.status}` }
          } catch (error) {
            return { success: false, output: '', error: (error as Error).message }
          }
        }
        return { success: false, output: '', error: `未知 action: ${action}` }
      }),
    },
    {
      name: 'team_send',
      description:
        '团队消息。to=成员名或 *（广播）或 Lead。协议消息首行：PLAN（计划待审批）、APPROVE/DENY（审批回复）、IDLE（任务完成通知）。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人（成员名 / Lead / * 广播）' },
          body: { type: 'string', description: '消息正文（可含协议首行）' },
        },
        required: ['to', 'body'],
      },
      execute: (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => executeWithContext(context, () => {
        const isLead = services.isLeadContext(context)
        const identity = isLead ? null : services.resolveMember(context)
        if (!identity && !isLead) {
          return { success: false, output: '', error: '无法识别消息发送者身份' }
        }
        const from = identity ? identity.member.name : 'lead'
        const requestedTo = String(args.to ?? '')
        const to = requestedTo.toLowerCase() === 'lead' ? (identity?.group.lead ?? 'lead') : requestedTo
        const body = String(args.body ?? '')
        if (!to || !body) return { success: false, output: '', error: '缺少 to/body' }
        if (to !== '*' && !isTeamActorName(to)) return { success: false, output: '', error: `非法收件人: ${to}` }
        services.sendMail(from, to, body)
        return { success: true, output: `已发送消息给 ${to}` }
      }),
    },
  ]
}
