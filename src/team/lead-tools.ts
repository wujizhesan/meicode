import type { Tool, ToolResult } from '../tools/index.ts'
import { TeamMail } from './index.ts'
import type { TeamManager } from './index.ts'
import type { TeamGroup } from './types.ts'

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
        '派生团队成员（协程驻留，独立上下文执行任务）。group=组名 member=成员名 role=角色名。专家角色清单：recon-expert 逆向侦察（write_paths 允许写 D:/reverse-notes 报告契约目录）/ replicator-expert 复刻 / verifier-expert 验证 / jsr-expert JS 签名加密 / acquisition-expert 数据采集 / frontend-expert 前端 / backend-expert 后端 / testing-expert 测试 / security-expert 安全 / general-purpose 通用。逆向侦察类任务必须用 recon-expert（有契约目录写权限），不要用 general-purpose。',
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
        await team.spawnMember(g, member, role, { needsApproval: args.needs_approval === true })
        return {
          success: true,
          output: `已派生成员 ${member}（角色: ${role}${args.needs_approval === true ? '，需审批' : ''}）加入小组 ${g.name}，随时可指派任务`,
        }
      },
    },
    {
      name: 'team_approve',
      description: '批准成员的审批请求（needsApproval 成员执行前会发 PLAN 等审批）。group=组名 member=成员名 note=备注（可选）。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          member: { type: 'string', description: '成员名' },
          note: { type: 'string', description: '审批备注（可选）' },
        },
        required: ['group', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}` }
        const member = String(args.member ?? '')
        const note = typeof args.note === 'string' ? args.note : undefined
        return { success: true, output: team.respondApproval(g.name, member, true, note) }
      },
    },
    {
      name: 'team_deny',
      description: '拒绝成员的审批请求。group=组名 member=成员名 note=拒绝原因（可选）。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组名' },
          member: { type: 'string', description: '成员名' },
          note: { type: 'string', description: '拒绝原因（可选）' },
        },
        required: ['group', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}` }
        const member = String(args.member ?? '')
        const note = typeof args.note === 'string' ? args.note : undefined
        return { success: true, output: team.respondApproval(g.name, member, false, note) }
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
        },
        required: ['group', 'task', 'member'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const member = String(args.member ?? '')
        const task = team.addTask(g.name, String(args.task ?? ''), member)
        const result = await team.runTask(g, task, member)
        return { success: true, output: `任务 ${task.id} 已完成\n${result.slice(0, 4000)}` }
      },
    },
    {
      name: 'team_tasks',
      description: '查看小组任务清单与结果。group=组名。',
      parameters: {
        type: 'object',
        properties: { group: { type: 'string', description: '组名' } },
        required: ['group'],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const g = loadGroup(String(args.group ?? ''))
        if (!g) return { success: false, output: '', error: `小组不存在: ${args.group}（先 team_create）` }
        const tasks = team.listTasks(g.name)
        if (tasks.length === 0) return { success: true, output: '（无任务）' }
        const lines = tasks.map((t) => {
          const base = `  ${t.id} [${t.status}] ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}`
          return t.result ? `${base}\n    结果: ${t.result.slice(0, 1500)}` : base
        })
        return { success: true, output: lines.join('\n') }
      },
    },
    {
      name: 'team_mail',
      description:
        '查看 Lead 邮箱（成员发来的消息：IDLE 任务完成通知 / PLAN 审批请求 / 一般汇报）。action=list 只看未读摘要；action=read 查看全部并标记已读。成员异步任务或需要决策时主动查看。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', description: 'list（未读摘要）或 read（全部+标记已读）' } },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const action = String(args.action ?? 'list')
        const msgs = team.readLeadMail(action === 'read')
        if (msgs.length === 0) return { success: true, output: '（邮箱为空）' }
        const unread = msgs.filter((m) => !m.read)
        const shown = action === 'read' ? msgs : unread
        if (shown.length === 0) return { success: true, output: '（无未读邮件）' }
        const lines = shown.map((m) => {
          const proto = TeamMail.parseProtocol(m.body).type
          return `[${proto}] ${new Date(m.ts).toLocaleTimeString()} ${m.from} → ${m.to}: ${m.summary ?? m.body.slice(0, 80)}`
        })
        const note = action === 'list' && unread.length > 0 ? `（共 ${unread.length} 封未读，read 查看详情并标记已读）` : ''
        return { success: true, output: lines.join('\n') + note }
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
        return { success: true, output: result }
      },
    },
  ]
}
