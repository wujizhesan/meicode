import type { CommandDef } from './types.ts'

const WORKFLOW_COMMANDS: CommandDef[] = [
  {
    name: 'workflow',
    aliases: ['wf'],
    description: 'Workflow 编排：create 创建模板 / validate 校验 / run 执行（对齐 Zcode .workflow.js DSL）',
    usage: '/workflow create|validate|run <名称>',
    type: 'local',
    paramHint: '操作: create|validate|run + 名称',
    handler: (args, ui) => {
      const action = args[0] ?? ''
      if (action === 'list') {
        ui.showMessage(ui.workflowAction('list', []))
        return
      }
      const name = args[1] ?? ''
      if (!name && action !== 'list') {
        ui.showMessage('用法: /workflow create|validate|run <名称>')
        return
      }
      ui.showMessage(ui.workflowAction(action, [name]))
    },
  },
  {
    name: 'workflows',
    description: 'Workflow 运行记录：列表 / 查看指定 runId 的 phase 详情',
    usage: '/workflows [runId]',
    type: 'local',
    paramHint: '可选: runId（查看详情）',
    handler: (args, ui) => {
      ui.showMessage(args[0] ? ui.workflowAction('run-info', [args[0]]) : ui.workflowAction('runs', []))
    },
  },
]

export const BUILTIN_COMMANDS: CommandDef[] = [
  ...WORKFLOW_COMMANDS,
  {
    name: 'help',
    description: '显示命令列表与用法',
    usage: '/help',
    type: 'local',
    handler: (_args, ui) => {
      const cmds = ui.listCommands(true)
      const lines = cmds.map((c) => `  ${c.usage.padEnd(28)} ${c.description}`)
      ui.showMessage(`命令列表（${cmds.length} 个）:\n` + lines.join('\n'))
    },
  },
  {
    name: 'compact',
    description: '手动压缩上下文（早期对话摘要化）',
    usage: '/compact',
    type: 'local',
    handler: async (_args, ui) => {
      ui.showMessage(await ui.compact())
    },
  },
  {
    name: 'clear',
    description: '清空当前对话历史（会话存档保留）',
    usage: '/clear',
    type: 'local',
    handler: (_args, ui) => {
      ui.clearHistory()
      ui.showMessage('已清空对话历史（存档保留，/session 可恢复）')
    },
  },
  {
    name: 'plan',
    aliases: ['p'],
    description: '进入计划模式（只读调查）；可带任务直接开始',
    usage: '/plan [任务描述]',
    type: 'ui',
    paramHint: '可选：要计划的任务',
    handler: (args, ui) => {
      ui.setMode('plan')
      if (args.length > 0) ui.sendUserMessage(args.join(' '))
    },
  },
  {
    name: 'do',
    description: '退出计划模式，回到默认执行模式',
    usage: '/do',
    type: 'ui',
    handler: (_args, ui) => {
      ui.setMode('default')
      ui.showMessage('已退回默认模式')
    },
  },
  {
    name: 'mode',
    aliases: ['m'],
    description: '切换权限模式：default / edits / plan / yolo',
    usage: '/mode <default|edits|plan|yolo>',
    type: 'ui',
    paramHint: 'default / edits / plan / yolo',
    handler: (args, ui) => {
      const m = args[0]?.toLowerCase()
      if (m === 'default' || m === 'edits' || m === 'plan' || m === 'yolo') {
        ui.setMode(m)
      } else {
        ui.showMessage('用法: /mode <default|edits|plan|yolo>')
      }
    },
  },
  {
    name: 'snapshot',
    description: '保存当前工作区快照(git commit+tag),可回滚',
    usage: '/snapshot [备注]',
    type: 'local',
    paramHint: '备注(可选)',
    handler: async (args, ui) => {
      ui.showMessage(await ui.snapshotAction('snapshot', args.join(' ')))
    },
  },
  {
    name: 'rollback',
    description: '回滚到快照:stage 恢复 / clear 取消 / commit 确认',
    usage: '/rollback <tag> [stage|clear|commit]',
    type: 'local',
    paramHint: '<tag> stage|clear|commit',
    handler: async (args, ui) => {
      const action = args[1] ?? 'stage'
      ui.showMessage(await ui.snapshotAction('rollback', `${args[0] ?? ''} ${action}`))
    },
  },
  {
    name: 'session',
    aliases: ['resume'],
    description: '会话管理：列表 / 恢复 / 新建 / 删除',
    usage: '/session [id|new|del <id>]',
    type: 'local',
    paramHint: 'id | new | del <id>',
    handler: (args, ui) => {
      if (args[0] === 'new') {
        ui.showMessage(ui.sessionAction('new'))
      } else if (args[0] === 'del') {
        ui.showMessage(ui.sessionAction('del', args[1] ?? ''))
      } else if (args[0]) {
        ui.showMessage(ui.sessionAction('resume', args[0]))
      } else {
        ui.showMessage(ui.sessionAction('list'))
      }
    },
  },
  {
    name: 'memory',
    description: '查看记忆笔记列表与索引',
    usage: '/memory',
    type: 'local',
    handler: (_args, ui) => {
      ui.showMessage(ui.memoryList())
    },
  },
  {
    name: 'permission',
    description: '查看当前权限模式与规则概要',
    usage: '/permission',
    type: 'local',
    handler: (_args, ui) => {
      ui.showMessage(ui.permissionSummary())
    },
  },
  {
    name: 'skill',
    description: '查看可用 Skills / 激活 / 停用',
    usage: '/skill [名称|list|off <名称>]',
    type: 'local',
    paramHint: '名称 或 off <名称>',
    handler: (args, ui) => {
      if (args[0] === 'off' && args[1]) {
        ui.showMessage(ui.skillDeactivate(args[1]))
      } else if (args[0]) {
        ui.showMessage(ui.skillActivate(args[0]))
      } else {
        ui.showMessage(ui.skillList())
      }
    },
  },
  {
    name: 'team',
    description: '团队编排：create 建组 / spawn 派生成员 / assign 派活 / tasks 任务 / merge 合并',
    usage: '/team <create|spawn|assign|tasks|merge|list> ...',
    type: 'local',
    paramHint: 'create <组名> | spawn <组> <成员> <角色> | assign <组> <任务> <成员> | tasks <组> | merge <组> | list',
    handler: (args, ui) => {
      const action = args[0] ?? 'list'
      ui.showMessage(ui.teamAction(action, args.slice(1)))
    },
  },
  {
    name: 'status',
    description: '显示模式 / token / 缓存命中 / 会话状态',
    usage: '/status',
    type: 'local',
    handler: (_args, ui) => {
      ui.showMessage(ui.getStatus())
    },
  },
  {
    name: 'audit',
    aliases: ['events'],
    description: '查询服务审计事件，可按类型、Task 或 Request 过滤',
    usage: '/audit [kind|task <id>|request <id>] [limit]',
    type: 'local',
    paramHint: 'kind | task <id> | request <id>，默认最近 20 条',
    handler: (args, ui) => {
      ui.showMessage(ui.auditAction(args))
    },
  },
]
