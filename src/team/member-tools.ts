import type { Tool, ToolContext, ToolResult } from '../tools/index.ts'
import type { TeamGroup, TeamMember, TeamTask } from './types.ts'

export interface MemberToolServices {
  resolveMemberByCwd: (cwd: string) => { group: TeamGroup; member: TeamMember } | null
  listTasks: (groupName: string) => TeamTask[]
  addTask: (groupName: string, title: string, assignee?: string, dependencies?: string[], maxAttempts?: number) => TeamTask
  updateTask: (groupName: string, taskId: string, patch: Record<string, unknown>) => TeamTask | null
  sendMail: (from: string, to: string, body: string) => void
}

export function createMemberTools(services: MemberToolServices): Tool[] {
  return [
    {
      name: 'team_task',
      description:
        '团队共享任务操作。action=list 查看任务清单；create 创建（title/assignee）；update 更新状态（id/status: todo|in_progress|done|failed）；result 记录结果。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list / create / update' },
          id: { type: 'string', description: '任务 id（update 用）' },
          title: { type: 'string', description: '任务标题（create 用）' },
          assignee: { type: 'string', description: '负责人（create 用）' },
          depends_on: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表（create 用）' },
          max_attempts: { type: 'number', description: '最多执行次数（create 用）' },
          status: { type: 'string', description: '任务状态' },
          result: { type: 'string', description: '任务结果摘要（update 用）' },
        },
        required: ['action'],
      },
      execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
        const identity = services.resolveMemberByCwd(context.cwd)
        if (!identity) return { success: false, output: '', error: '无法识别成员身份（ctx.cwd 不在任何成员 workdir）' }
        const groupName = identity.group.name
        const memberName = identity.member.name
        const action = String(args.action ?? '')
        if (action === 'list') {
          const tasks = services.listTasks(groupName)
          return { success: true, output: tasks.length ? JSON.stringify(tasks, null, 2) : '（无任务）' }
        }
        if (action === 'create') {
          const dependencies = Array.isArray(args.depends_on)
            ? args.depends_on.filter((value): value is string => typeof value === 'string')
            : []
          const maxAttempts = typeof args.max_attempts === 'number' && args.max_attempts > 0
            ? Math.floor(args.max_attempts)
            : 1
          try {
            const task = services.addTask(
              groupName,
              String(args.title ?? '未命名'),
              typeof args.assignee === 'string' ? args.assignee : memberName,
              dependencies,
              maxAttempts,
            )
            return { success: true, output: `已创建任务 ${task.id}: ${task.title}` }
          } catch (error) {
            return { success: false, output: '', error: (error as Error).message }
          }
        }
        if (action === 'update') {
          const taskId = String(args.id ?? '')
          const update: Record<string, unknown> = {}
          if (typeof args.status === 'string') update.status = args.status
          if (typeof args.result === 'string') update.result = args.result
          const task = services.updateTask(groupName, taskId, update)
          if (!task) return { success: false, output: '', error: `任务不存在: ${taskId}` }
          return { success: true, output: `任务 ${taskId} 已更新: ${task.status}` }
        }
        return { success: false, output: '', error: `未知 action: ${action}` }
      },
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
      execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
        const identity = services.resolveMemberByCwd(context.cwd)
        const from = identity ? identity.member.name : 'lead'
        const to = String(args.to ?? '')
        const body = String(args.body ?? '')
        if (!to || !body) return { success: false, output: '', error: '缺少 to/body' }
        services.sendMail(from, to, body)
        return { success: true, output: `已发送消息给 ${to}` }
      },
    },
  ]
}
