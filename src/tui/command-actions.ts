import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiController } from '../commands/index.ts'
import type { Provider } from '../provider/types.ts'
import type { SubAgentManager } from '../subagent/index.ts'
import type { TeamManager } from '../team/index.ts'
import type { ToolContext, ToolRegistry } from '../tools/index.ts'
import type { WorkflowRunRecord } from '../workflow/index.ts'
import {
  WORKFLOW_TEMPLATE,
  cancelRun,
  ensureWorkflowDirs,
  listRuns,
  listWorkflows,
  loadRun,
  loadWorkflow,
  runWorkflow,
  validateWorkflowMeta,
} from '../workflow/index.ts'

type Notify = (message: string) => void
const activeWorkflowRuns = new Set<string>()

function snapshotToolContext(ctx: ToolContext): ToolContext {
  return {
    ...ctx,
    permission: ctx.permission ? { ...ctx.permission } : undefined,
    rootLockExtra: ctx.rootLockExtra ? [...ctx.rootLockExtra] : undefined,
  }
}

export function cancelWorkflowExecutions(
  record: WorkflowRunRecord,
  subAgentManager: SubAgentManager,
  teamManager?: TeamManager | null,
): void {
  const agentIds = new Set<string>()
  const teamTasks = new Map<string, Set<string>>()
  const subagentRecords = typeof subAgentManager.listRecords === 'function' ? subAgentManager.listRecords(record.sessionId) : []
  for (const phase of record.phases) {
    if (phase.backend !== 'team' && !phase.teamGroup) {
      for (const id of phase.agentIds ?? (phase.agentId ? [phase.agentId] : [])) agentIds.add(id)
    }
    if (phase.teamGroup) {
      const taskIds = teamTasks.get(phase.teamGroup) ?? new Set<string>()
      for (const id of phase.taskIds ?? []) taskIds.add(id)
      teamTasks.set(phase.teamGroup, taskIds)
    }
    for (const slot of phase.dispatchSlots ?? []) {
      if (slot.backend === 'subagent') {
        const id = slot.agentId ?? subagentRecords.find((item) => item.taskId === slot.dispatchId)?.id
        if (id) agentIds.add(id)
        continue
      }
      const group = slot.teamGroup ?? phase.teamGroup
      if (!group || !teamManager) continue
      const id = slot.taskId ?? teamManager.listTasks(group).find((item) => item.dispatchId === slot.dispatchId)?.id
      if (!id) continue
      const taskIds = teamTasks.get(group) ?? new Set<string>()
      taskIds.add(id)
      teamTasks.set(group, taskIds)
    }
  }
  for (const id of agentIds) subAgentManager.cancel(id, record.sessionId)
  if (!teamManager) return
  for (const [group, taskIds] of teamTasks) {
    for (const id of taskIds) teamManager.cancelTask(group, id)
  }
}

export function createTeamAction(
  teamManager: TeamManager | null | undefined,
  notify: Notify,
): UiController['teamAction'] {
  return (action, args) => {
    if (!teamManager) return '团队系统未启用'
    try {
      if (action === 'list') {
        const groups = teamManager.listGroups()
        return groups.length ? `小组: ${groups.join(', ')}` : '暂无小组'
      }
      if (action === 'create') {
        const name = args[0]
        if (!name) return '用法: /team create <组名>'
        if (teamManager.loadGroup(name)) return `小组已存在: ${name}`
        teamManager.createGroup(name, 'lead')
        return `已创建小组: ${name}`
      }
      if (action === 'spawn') {
        const [group, member, role] = args
        if (!group || !member || !role) return '用法: /team spawn <组> <成员> <角色>'
        const current = teamManager.loadGroup(group)
        if (!current) return `小组不存在: ${group}`
        void teamManager.spawnMember(current, member, role)
          .then(() => notify(`已派生成员 ${member}（角色: ${role}）加入小组 ${group}`))
          .catch((error: Error) => notify(`派生成员失败: ${error.message}`))
        return `正在派生成员 ${member}（角色: ${role}）...`
      }
      if (action === 'tasks') {
        const group = args[0]
        if (!group) return '用法: /team tasks <组>'
        const tasks = teamManager.listTasks(group)
        return tasks.length
          ? tasks.map((task) => `  ${task.id} [${task.status}] ${task.title}${task.assignee ? ` → ${task.assignee}` : ''}`).join('\n')
          : '（无任务）'
      }
      if (action === 'assign') {
        if (args.length < 3) return '用法: /team assign <组> <任务描述> <成员>'
        const group = args[0]
        const member = args.at(-1)!
        const title = args.slice(1, -1).join(' ')
        const current = teamManager.loadGroup(group)
        if (!current) return `小组不存在: ${group}`
        const task = teamManager.addTask(group, title, member)
        void teamManager.assignTask(current, task, member)
          .then(notify)
          .catch((error: Error) => notify(`任务指派失败: ${error.message}`))
        return `已创建任务 ${task.id} 并指派 ${member}`
      }
      if (action === 'merge') {
        const group = args[0]
        if (!group) return '用法: /team merge <组>'
        const current = teamManager.loadGroup(group)
        if (!current) return `小组不存在: ${group}`
        void teamManager.mergeAll(current)
          .then((result) => notify(result.success ? result.output : `合并失败: ${result.output}`))
          .catch((error: Error) => notify(`合并失败: ${error.message}`))
        return '开始合并成员 worktree...'
      }
      return `未知操作: ${action}`
    } catch (error) {
      return `团队操作失败: ${(error as Error).message}`
    }
  }
}

export interface WorkflowActionOptions {
  cwd: string
  provider: Provider
  registry: ToolRegistry
  subAgentManager?: SubAgentManager | null
  teamManager?: TeamManager | null
  getContext: () => ToolContext
  notify: Notify
}

export function createWorkflowAction(options: WorkflowActionOptions): UiController['workflowAction'] {
  return (action, args) => {
    const { cwd, provider, registry, subAgentManager, teamManager, getContext, notify } = options
    if (!subAgentManager) return 'Workflow 需要子 agent 系统'
    try {
      if (action === 'list') {
        const workflows = listWorkflows(cwd)
        return workflows.length ? `workflows: ${workflows.join(', ')}` : '暂无 workflow（/workflow create <名称> 创建）'
      }
      if (action === 'create') {
        const name = args[0]
        if (!name) return '用法: /workflow create <名称>'
        if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'Workflow 名称仅允许字母、数字、下划线和连字符'
        const { project } = ensureWorkflowDirs(cwd)
        const file = join(project, `${name}.workflow.js`)
        if (existsSync(file)) return `已存在: ${file}`
        writeFileSync(file, WORKFLOW_TEMPLATE.replace('NAME', name).replace('DESC', `${name} workflow`), 'utf8')
        return `已创建: ${file}\n编辑后 /workflow validate ${name} 校验`
      }
      if (action === 'validate') {
        const name = args[0]
        if (!name) return '用法: /workflow validate <名称>'
        void loadWorkflow(cwd, name)
          .then((meta) => {
            const issues = validateWorkflowMeta(meta)
            notify(issues.length === 0
              ? `校验通过: ${meta.name} (${meta.phases.length} phases)`
              : `校验失败:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`)
          })
          .catch((error: Error) => notify(`校验失败: ${error.message}`))
        return `正在校验 ${name}...`
      }
      if (action === 'run') {
        const [name, ...flags] = args
        if (!name) return '用法: /workflow run <名称> [--team|--subagent]'
        if (flags.some((flag) => flag !== '--team' && flag !== '--subagent') || (flags.includes('--team') && flags.includes('--subagent'))) {
          return '用法: /workflow run <名称> [--team|--subagent]'
        }
        const useTeam = flags.includes('--team')
        if (useTeam && !teamManager) return '团队系统未启用，无法使用 --team'
        const executionContext = snapshotToolContext(getContext())
        void loadWorkflow(cwd, name)
          .then((meta) => runWorkflow(meta, {
            provider,
            registry,
            ctx: executionContext,
            subagents: subAgentManager,
            ...(useTeam ? { team: { manager: teamManager! } } : {}),
            onProgress: notify,
          }).then((record) => notify(`[workflow] ${meta.name}: ${record.status} — /workflows 查看`)))
          .catch((error: Error) => notify(`[workflow] 运行失败: ${error.message}`))
        return `已启动 workflow ${name}（${useTeam ? '团队' : '子 Agent'}后端，进度见提示）`
      }
      if (action === 'resume') {
        const runId = args[0]
        if (!runId) return '用法: /workflow resume <runId>'
        if (activeWorkflowRuns.has(runId)) return `workflow ${runId} 已在恢复中`
        const existing = loadRun(cwd, runId)
        if (!existing) return `运行不存在: ${runId}`
        if (existing.status !== 'paused' && existing.status !== 'running') return `运行 ${runId} 当前状态为 ${existing.status}，无需恢复`
        const usesTeam = existing.backend === 'team' || existing.phases.some((phase) => phase.backend === 'team')
        if (usesTeam && !teamManager) return `workflow ${runId} 使用团队后端，但团队系统未启用，无法恢复`
        const executionContext = snapshotToolContext(getContext())
        activeWorkflowRuns.add(runId)
        void loadWorkflow(cwd, existing.workflow)
          .then((meta) => runWorkflow(meta, {
            provider,
            registry,
            ctx: executionContext,
            subagents: subAgentManager,
            ...(usesTeam ? { team: { manager: teamManager! } } : {}),
            onProgress: notify,
          }, existing))
          .then((record) => notify(`[workflow] ${record.workflow}: ${record.status} — /workflows ${record.runId}`))
          .catch((error: Error) => notify(`[workflow] 恢复失败: ${error.message}`))
          .finally(() => activeWorkflowRuns.delete(runId))
        return `正在恢复 workflow ${runId}...`
      }
      if (action === 'cancel') {
        const runId = args[0]
        if (!runId) return '用法: /workflow cancel <runId>'
        const record = cancelRun(cwd, runId)
        if (!record) return `运行不存在: ${runId}`
        cancelWorkflowExecutions(record, subAgentManager, teamManager)
        activeWorkflowRuns.delete(runId)
        return record.status === 'cancelled' ? `已取消 workflow ${runId}` : `workflow ${runId} 已结束: ${record.status}`
      }
      if (action === 'runs') {
        const runs = listRuns(cwd)
        if (!runs.length) return '暂无运行记录'
        return runs.map((run) => {
          const done = run.phases.filter((phase) => phase.status === 'completed').length
          const status = run.reconcileBlocked ? 'attention' : run.status
          return `  ${run.runId.slice(0, 8)} ${run.workflow.padEnd(16)} ${status.padEnd(9)} ${done}/${run.phases.length} ${new Date(run.createdAt).toLocaleTimeString()}`
        }).join('\n')
      }
      if (action === 'run-info') {
        const runId = args[0]
        if (!runId) return '用法: /workflows <runId>'
        const record = loadRun(cwd, runId)
        if (!record) return `运行不存在: ${runId}`
        const details = record.phases
          .map((phase) => `  ${phase.status.padEnd(9)} ${phase.title}${phase.artifactPath ? ` → ${phase.artifactPath}` : ''}${phase.error ? ` (${phase.error})` : ''}`)
        if (record.lastReconcileError) {
          details.unshift(`  recovery  ${record.reconcileBlocked ? '等待人工处理' : `第 ${record.reconcileAttempts ?? 1} 次失败`}：${record.lastReconcileError}`)
        }
        details.unshift(`  backend   ${record.backend ?? record.phases.find((phase) => phase.backend)?.backend ?? 'legacy'}`)
        return details.join('\n')
      }
      return '用法: /workflow create|validate|run <名称> [--team|--subagent] | resume|cancel <runId>'
    } catch (error) {
      return `workflow 操作失败: ${(error as Error).message}`
    }
  }
}
