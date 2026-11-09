import type { Tool, ToolResult } from '../tools/index.ts'
import { TeamMail } from './index.ts'
import type { TeamManager } from './index.ts'
import type { TeamGroup, TeamTask } from './types.ts'
import { paginateTasks, taskSummary } from './task-page.ts'
import { isTeamActorName, parseTaskDependencies, parseTaskMaxAttempts, parseTaskTitle, TASK_MAX_ATTEMPTS } from './validation.ts'

// Lead 侧编排工具：主会话模型可直接用（一句话完成建组/派生/派活，无需引导用户敲 /team 命令）
export function createLeadTools(team: TeamManager): Tool[] {
  const loadGroup = (name: string): TeamGroup | null => team.loadGroup(name)
  return [
    {
      name: 'team_create',
      description: '创建团队小组。name=组名。任何团队操作前必须先建组。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '组名' } },
        required: ['name'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const name = String(args.name ?? '')
        if (!name) return { success: false, output: '', error: '缺少参数 name' }
        if (loadGroup(name)) return { success: true, output: `小组已存在: ${name}` }
        team.createGroup(name, 'lead')
        return { success: true, output: `已创建小组: ${name}` }
      },
    },
    {
      name: 'team_spawn',
      description:
      '派生团队成员：独立上下文执行任务。group=组名，member=成员名，role=角色名。可用角色：frontend-expert / backend-expert / testing-expert / security-expert / general-purpose。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          member: { type: 'string', description: '成员名' },
          role: { type: 'string', description: '角色名（如 general-purpose）' },
          needs_approval: { type: 'boolean', description: '成员执行任务前需 Lead 审批（默认 false）' },
        },
        required: ['group', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const member = String(args.member ?? '')
        if (!member) return { success: false, output: '', error: '缺少参数 member' }
        const role = String(args.role ?? 'general-purpose')
        try {
          await team.spawnMember(g, member, role, { needsApproval: args.needs_approval === true })
        } catch (error) {
          return { success: false, output: '', error: (error as Error).message }
        }
        return {
          success: true,
          output: `已派生成员 ${member}（角色: ${role}${args.needs_approval === true ? '，需审批' : ''}）加入小组 ${g.name}，随时可指派任务`,
        }
      },
    },
    {
      name: 'team_approve',
      description: '批准成员的审批请求。优先传入 PLAN 邮件中的 task_id 与 correlation_id，避免审批串到其他任务。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          member: { type: 'string', description: '成员名' },
          task_id: { type: 'string', description: 'PLAN 中的任务 ID（推荐）' },
          correlation_id: { type: 'string', description: 'PLAN 中的审批关联 ID（推荐）' },
          note: { type: 'string', description: '审批备注（可选）' },
        },
        required: ['group', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}` }
        const member = String(args.member ?? '')
        const note = typeof args.note === 'string' ? args.note : undefined
        const output = team.respondApproval(
          g.name,
          member,
          true,
          note,
          typeof args.task_id === 'string' ? args.task_id : undefined,
          typeof args.correlation_id === 'string' ? args.correlation_id : undefined,
        )
        return output.startsWith('审批失败:') ? { success: false, output: '', error: output } : { success: true, output }
      },
    },
    {
      name: 'team_deny',
      description: '拒绝成员的审批请求。优先传入 PLAN 邮件中的 task_id 与 correlation_id，note 可填写拒绝原因。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          member: { type: 'string', description: '成员名' },
          task_id: { type: 'string', description: 'PLAN 中的任务 ID（推荐）' },
          correlation_id: { type: 'string', description: 'PLAN 中的审批关联 ID（推荐）' },
          note: { type: 'string', description: '拒绝原因（可选）' },
        },
        required: ['group', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}` }
        const member = String(args.member ?? '')
        const note = typeof args.note === 'string' ? args.note : undefined
        const output = team.respondApproval(
          g.name,
          member,
          false,
          note,
          typeof args.task_id === 'string' ? args.task_id : undefined,
          typeof args.correlation_id === 'string' ? args.correlation_id : undefined,
        )
        return output.startsWith('审批失败:') ? { success: false, output: '', error: output } : { success: true, output }
      },
    },
    {
      name: 'team_assign',
      description:
        '派发任务给成员并等待其执行完成，返回成员执行结果。group=组名 task=任务描述（一句话） member=成员名。执行可能耗时几十秒。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          task: { type: 'string', description: '任务描述' },
          member: { type: 'string', description: '成员名' },
          depends_on: { type: 'array', items: { type: 'string' }, description: '依赖任务 ID 列表' },
          max_attempts: { type: 'integer', minimum: 1, maximum: TASK_MAX_ATTEMPTS, description: '最多执行次数' },
        },
        required: ['group', 'task', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        if (typeof args.group !== 'string' || !args.group.trim()) return { success: false, output: '', error: 'group 必须是非空字符串' }
        const g = loadGroup(args.group)
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const member = args.member
        if (typeof member !== 'string' || !isTeamActorName(member)) return { success: false, output: '', error: 'member 必须是合法成员名' }
        let task: TeamTask
        try {
          task = team.addTask(g.name, parseTaskTitle(args.task), member, parseTaskDependencies(args.depends_on), parseTaskMaxAttempts(args.max_attempts))
        } catch (e) {
          return { success: false, output: '', error: (e as Error).message }
        }
        const result = await team.runTask(g, task, member)
        const current = team.listTasks(g.name).find((item) => item.id === task.id)
        if (!current) return { success: false, output: '', error: `任务 ${task.id} 执行后丢失` }
        if (current.status === 'done') {
          return { success: true, output: `任务 ${task.id} 已完成\n${result.slice(0, 4000)}` }
        }
        if (current.status === 'failed') {
          return { success: false, output: '', error: `任务 ${task.id} 执行失败\n${result.slice(0, 4000)}` }
        }
        if (current.status === 'cancelled') {
          return { success: false, output: '', error: `任务 ${task.id} 已取消` }
        }
        if (current.status === 'in_progress') {
          return { success: true, output: `任务 ${task.id} 仍在执行中\n${result.slice(0, 4000)}` }
        }
        if (current.nextRetryAt) {
          return { success: true, output: `任务 ${task.id} 执行失败，已安排重试\n${result.slice(0, 4000)}` }
        }
        const blockers = team.taskBlockers(g.name, current)
        return {
          success: true,
          output: blockers.length > 0
            ? `任务 ${task.id} 已创建，等待依赖完成: ${blockers.join(', ')}`
            : `任务 ${task.id} 已进入队列\n${result.slice(0, 4000)}`,
        }
      },
    },
    {
      name: 'team_tasks',
      description: '分页查看小组任务，默认最近 50 条。可按 status 筛选，使用 cursor 查看更早任务，或用 id 查看单条完整任务。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          id: { type: 'string', description: '任务 ID；提供时返回单条完整任务' },
          status: { type: 'string', description: '筛选 todo / in_progress / done / failed / cancelled' },
          limit: { type: 'number', description: '每页数量，默认 50，最多 100' },
          cursor: { type: 'string', description: '上一页返回的下一页游标' },
        },
        required: ['group'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const tasks = team.listTasks(g.name)
        if (args.id !== undefined) {
          if (typeof args.id !== 'string' || !args.id) return { success: false, output: '', error: '任务 ID 必须是非空字符串' }
          const task = tasks.find((item) => item.id === args.id)
          return task
            ? { success: true, output: JSON.stringify(task, null, 2) }
            : { success: false, output: '', error: `任务不存在: ${args.id}` }
        }
        let page: ReturnType<typeof paginateTasks>
        try {
          page = paginateTasks(tasks, args)
        } catch (error) {
          return { success: false, output: '', error: (error as Error).message }
        }
        if (tasks.length === 0) return { success: true, output: '（无任务）' }
        if (page.tasks.length === 0) return { success: true, output: `（无匹配任务，共 ${page.total} 条）` }
        const lines = page.tasks.map((task) => {
          const item = taskSummary(task)
          const base = `  ${item.id} [${item.status}] ${item.title}${item.assignee ? ` → ${item.assignee}` : ''}`
          return item.resultPreview ? `${base}\n    结果: ${item.resultPreview}` : base
        })
        const next = page.nextCursor === undefined ? '' : `\n下一页参数：${JSON.stringify({ group: g.name, limit: args.limit ?? 50, ...(args.status ? { status: args.status } : {}), cursor: page.nextCursor })}`
        return { success: true, output: `共 ${page.total} 条任务，匹配 ${page.matched} 条，本页 ${page.tasks.length} 条\n${lines.join('\n')}${next}` }
      },
    },
    {
      name: 'team_schedule',
      description: '扫描并派发当前可执行的 Team 任务。group=组名。任务必须有负责人且依赖已完成。',
      parameters: {
        type: 'object',
        properties: { group: { type: 'string', description: '组名' } },
        required: ['group'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const scheduled = team.scheduleReadyTasks(g.name)
        return { success: true, output: scheduled.length ? `已派发任务: ${scheduled.join(', ')}` : '当前没有可派发任务' }
      },
    },
    {
      name: 'team_mail',
      description:
        '分页查看 Lead 邮箱（成员发来的 IDLE / PLAN / 汇报）。group 可指定小组的负责人邮箱。action=list 查看未读；action=read 查看邮件并仅标记本页已读。默认最近 50 封，使用返回的 cursor 查看更早邮件。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（未读摘要）或 read（本页+标记本页已读）' },
          group: { type: 'string', description: '查看指定小组的负责人邮箱，默认 lead' },
          limit: { type: 'number', description: '每页数量，默认 50，最多 100' },
          cursor: { type: 'string', description: '上一页返回的下一页游标' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const action = String(args.action ?? 'list')
        const limit = args.limit ?? 50
        const cursor = args.cursor
        const groupName = args.group
        if (groupName !== undefined && (typeof groupName !== 'string' || !groupName)) return { success: false, output: '', error: '组名必须是非空字符串' }
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return { success: false, output: '', error: '邮件每页数量必须在 1-100 之间' }
        }
        if (cursor !== undefined && typeof cursor !== 'string') {
          return { success: false, output: '', error: '邮件分页游标必须是字符串' }
        }
        let page: ReturnType<TeamManager['readLeadMailPage']>
        try {
          page = team.readLeadMailPage({ unreadOnly: action !== 'read', markRead: action === 'read', limit, cursor }, groupName)
        } catch (error) {
          return { success: false, output: '', error: (error as Error).message }
        }
        if (page.total === 0) return { success: true, output: '（邮箱为空）' }
        if (page.messages.length === 0) return { success: true, output: action === 'read' ? '（当前页无邮件）' : '（无未读邮件）' }
        const lines = page.messages.map((m) => {
          const proto = TeamMail.parseProtocol(m.body).type
          const ids = [m.taskId ? `task=${m.taskId}` : '', m.correlationId ? `correlation=${m.correlationId}` : ''].filter(Boolean).join(' ')
          return `[${proto}] ${new Date(m.ts).toLocaleTimeString()} ${m.from} → ${m.to}${ids ? ` (${ids})` : ''}: ${m.summary ?? m.body.slice(0, 80)}`
        })
        const note = action === 'read'
          ? `共 ${page.total} 封邮件，本页 ${page.messages.length} 封`
          : `共 ${page.unreadTotal} 封未读，本页 ${page.messages.length} 封`
        const next = page.nextCursor === undefined ? '' : `\n下一页参数：${JSON.stringify({ action, ...(groupName !== undefined ? { group: groupName } : {}), limit, cursor: page.nextCursor })}`
        return { success: true, output: `${note}\n${lines.join('\n')}${next}` }
      },
    },
    {
      name: 'team_merge',
      description:
        '把成员的 worktree 改动合并回主仓库（成员改动自动 commit 后 merge，冲突时回滚保留 worktree 待处理）。group=组名。成员任务完成后必须调用此工具汇总成果，不要用 edit_file 手工抄写。',
      parameters: {
        type: 'object',
        properties: { group: { type: 'string', description: '组名' } },
        required: ['group'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const result = await team.mergeAll(g)
        return result.success ? { success: true, output: result.output } : { success: false, output: result.output, error: result.output }
      },
    },
  ]
}
