import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Provider } from '../provider/types.ts'
import type { Tool, ToolContext, ToolRegistry } from '../tools/index.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import { loadAgentRoles, agentDirs } from '../subagent/loader.ts'
import type { AgentRole } from '../subagent/types.ts'
import { TeamGroupStore } from './group.ts'
import { TeamMail } from './mail.ts'
import { MemberHost } from './member.ts'
import type { MailMessage, TeamGroup, TeamMember, TeamTask } from './types.ts'
import { createRuntimeId } from '../runtime/index.ts'
import { readCoordinatorConfig } from './config.ts'
import { createMemberTools } from './member-tools.ts'
import { mergeTeamWorktrees } from './merge.ts'
import type { TeamMergeResult } from './merge.ts'
import { projectStatePath } from '../state-paths.ts'
import { TeamTaskScheduler } from './task-scheduler.ts'
import { assertTeamActorName, teamActorKey } from './validation.ts'

function sameTeamMember(left: TeamMember, right: TeamMember): boolean {
  return left.name === right.name
    && left.agentId === right.agentId
    && left.role === right.role
    && left.workdir === right.workdir
    && left.backend === right.backend
    && left.needsApproval === right.needsApproval
    && left.status === right.status
    && left.updatedAt === right.updatedAt
}

export class TeamManager {
  private store: TeamGroupStore
  private mail: TeamMail
  private members = new Map<string, MemberHost>()
  private memberGroups = new Map<string, string>()
  private memberAgents = new Map<string, { groupName: string; memberName: string }>()
  private memberWorktrees = new Map<string, string>()
  private repoRoot: string
  private cfgCoordinator: boolean
  private worktrees: WorktreeManager | null
  private scheduler: TeamTaskScheduler

  private opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext }

  constructor(
    root: string,
    repoRoot: string,
    opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext },
    worktrees?: WorktreeManager | null,
  ) {
    this.opts = opts
    this.store = new TeamGroupStore(root)
    this.mail = new TeamMail(join(root, '_shared', 'mail'))
    this.repoRoot = repoRoot
    this.cfgCoordinator = readCoordinatorConfig(root)
    this.worktrees = worktrees ?? null
    this.scheduler = new TeamTaskScheduler({
      store: this.store,
      mail: this.mail,
      members: this.members,
      memberGroups: this.memberGroups,
      ctx: opts.ctx,
    })
  }

  // coordinator：配置开关 + 环境变量双锁
  isCoordinator(): boolean {
    return this.cfgCoordinator && process.env.MEWCOORDINATOR === '1'
  }

  createGroup(name: string, lead: string): TeamGroup {
    return this.store.createGroup(name, lead)
  }

  loadGroup(name: string): TeamGroup | null {
    return this.store.loadGroup(name)
  }

  listGroups(): string[] {
    return this.store.listGroups()
  }

  isClosed(): boolean {
    return this.scheduler.isClosed()
  }

  setSessionId(sessionId: string): void {
    this.opts.ctx.sessionId = sessionId
    this.scheduler.setSessionId(sessionId)
    for (const member of this.members.values()) member.setSessionId(sessionId)
  }

  private releaseMemberWorktree(memberName: string, worktreeName: string): void {
    if (!this.worktrees || this.memberWorktrees.get(memberName) !== worktreeName) return
    this.worktrees.release?.(worktreeName)
    this.memberWorktrees.delete(memberName)
  }

  async close(timeoutMs = 5000): Promise<void> {
    const pending = this.scheduler.close(timeoutMs)
    for (const member of this.members.values()) member.close()
    try {
      await pending
    } finally {
      if (this.worktrees) {
        for (const [memberName, worktreeName] of this.memberWorktrees) {
          const member = this.members.get(memberName)
          if (!member?.isBusy()) {
            this.releaseMemberWorktree(memberName, worktreeName)
            continue
          }
          void member.whenIdle().then(() => {
            this.releaseMemberWorktree(memberName, worktreeName)
          }).catch((error: unknown) => {
            console.warn(`[团队] 成员 ${memberName} 延迟释放 worktree 失败: ${(error as Error).message}`)
          })
        }
      } else {
        this.memberWorktrees.clear()
      }
    }
  }

  // 派生成员（协程驻留）：worktree 隔离 + 加入花名册 + 注册邮箱
  async spawnMember(
    group: TeamGroup,
    name: string,
    role: string,
    opts: {
      needsApproval?: boolean
      workdir?: string
      deferGroupSave?: boolean
      roleDefinition?: AgentRole | null
      agentId?: string
      updatedAt?: number
    } = {},
  ): Promise<MemberHost> {
    if (this.scheduler.isClosed()) throw new Error('TeamManager 已关闭，无法派生成员')
    assertTeamActorName(name)
    const memberKey = teamActorKey(name)
    if (memberKey === teamActorKey(group.lead)) throw new Error(`成员名不能与负责人 ${group.lead} 相同`)
    // 幂等：同名成员已驻留直接返回（不覆盖 host，避免双写同一 historyFile/worktree）
    const existingName = [...this.members.keys()].find((current) => teamActorKey(current) === memberKey)
    const existing = existingName ? this.members.get(existingName) : undefined
    if (existing) {
      const ownerGroup = this.memberGroups.get(existingName!)
      if (existingName !== name) throw new Error(`成员名大小写冲突: ${name} 与 ${existingName}`)
      if (ownerGroup === group.name) return existing
      throw new Error(`成员名 ${name} 已属于小组 ${ownerGroup ?? '未知'}，不能加入小组 ${group.name}`)
    }
    const persistedGroup = this.store.loadGroup(group.name)
    if (!persistedGroup || persistedGroup.lead !== group.lead) throw new Error(`小组 ${group.name} 不存在或已发生变化`)
    for (const groupName of this.store.listGroups()) {
      const candidate = groupName === group.name ? persistedGroup : this.store.loadGroup(groupName)
      const conflict = candidate?.members.find((member) => teamActorKey(member.name) === memberKey)
      if (!conflict) continue
      if (conflict.name !== name) throw new Error(`成员名大小写冲突: ${name} 与 ${conflict.name}`)
    }
    const agentId = opts.agentId ?? createRuntimeId('agent')
    const agentOwner = this.memberAgents.get(agentId)
    if (agentOwner && (agentOwner.groupName !== group.name || agentOwner.memberName !== name)) {
      throw new Error(`Agent ID ${agentId} 已属于成员 ${agentOwner.memberName}`)
    }
    // 专家角色（对齐 Qoder 专家团）：按 role 名从角色文件加载 SOP 正文与工具限制
    let rolePrompt = ''
    let roleToolsDeny: string[] = []
    let roleToolsAllow: string[] = []
    let roleWritePaths: string[] = []
    let roleMaxRounds: number | undefined
    try {
      const found = 'roleDefinition' in opts
        ? opts.roleDefinition
        : loadAgentRoles(agentDirs(this.repoRoot)).find((r) => r.name === role)
      if (found) {
        rolePrompt = found.content
        roleToolsDeny = found.toolsDeny ?? []
        roleToolsAllow = found.toolsAllow ?? []
        roleWritePaths = found.writePaths ?? []
        roleMaxRounds = found.maxRounds
      }
    } catch {
      // 角色加载失败降级为基础成员
    }
    // 全局共享产物区：成员中间产物互通（实战: 抓的页面他人读不到）
    const sharedArtifacts = projectStatePath(this.repoRoot, 'artifacts')
    mkdirSync(sharedArtifacts, { recursive: true })
    // 成员独立 worktree（分支 wt-member-<name>），写文件不污染主仓库
    // 恢复场景(opts.workdir):复用已记录的 workdir,不重新 create
    let workdir = opts.workdir ?? this.repoRoot
    let createdWorktreeName: string | undefined
    let leasedWorktreeName: string | undefined
    if (!opts.workdir && this.worktrees) {
      createdWorktreeName = `member-${name}`
      try {
        const wt = await this.worktrees.create(createdWorktreeName)
        workdir = wt.path
        leasedWorktreeName = createdWorktreeName
      } catch (e) {
        throw new Error(`成员 ${name} worktree 创建失败，已拒绝无隔离启动: ${(e as Error).message}`)
      }
    } else if (opts.workdir && this.worktrees) {
      const root = resolve(this.worktrees.getRoot())
      const restored = resolve(opts.workdir)
      const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
      const restoredKey = process.platform === 'win32' ? restored.toLowerCase() : restored
      if (restoredKey.startsWith(`${rootKey}/`) || restoredKey.startsWith(rootKey + '\\')) {
        leasedWorktreeName = `member-${name}`
        try {
          const wt = await this.worktrees.attach(leasedWorktreeName, restored)
          workdir = wt.path
        } catch (e) {
          throw new Error(`成员 ${name} worktree 恢复失败，已拒绝无租约启动: ${(e as Error).message}`)
        }
      }
    }
    const member: TeamMember = {
      name,
      agentId,
      role,
      workdir,
      backend: 'coroutine',
      needsApproval: opts.needsApproval ?? false,
      status: 'idle',
      ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {}),
    }
    let host: MemberHost
    try {
      this.mail.register(name)
      host = new MemberHost(
        member,
        group.name,
        {
          provider: this.opts.provider,
          registry: this.opts.registry,
          // rootLock：成员文件工具只能写 worktree 内（隔离主仓库）；rootLockExtra：契约报告目录 + 共享产物区
          ctx: {
            ...this.opts.ctx,
            agentId: member.agentId,
            cwd: workdir,
            rootLock: workdir,
            rootLockExtra: [...(roleWritePaths.length ? roleWritePaths : []), sharedArtifacts],
          },
          historyFile: join(this.store.groupDir(group.name), 'members', `${name}.history.jsonl`),
          store: this.store,
          mail: this.mail,
          rolePrompt,
          roleToolsDeny,
          roleToolsAllow,
          roleMaxRounds,
          parentAgentId: this.opts.ctx.agentId,
        },
      )
      if (opts.deferGroupSave) {
        group.members = group.members.filter((current) => current.name !== member.name)
        group.members.push(member)
      } else {
        this.store.addMember(group, member)
      }
    } catch (error) {
      if (createdWorktreeName && this.worktrees) {
        try {
          const rollback = await this.worktrees.remove(createdWorktreeName)
          if (!rollback.startsWith('已删除')) console.warn(`[团队] 成员 ${name} 初始化失败，worktree 回滚未完成: ${rollback}`)
        } catch (rollbackError) {
          console.warn(`[团队] 成员 ${name} 初始化失败，worktree 回滚异常: ${(rollbackError as Error).message}`)
        }
      } else if (leasedWorktreeName && this.worktrees) {
        this.worktrees.release?.(leasedWorktreeName)
      }
      throw error
    }
    this.memberGroups.set(name, group.name)
    this.memberAgents.set(member.agentId!, { groupName: group.name, memberName: name })
    this.members.set(name, host)
    if (leasedWorktreeName) this.memberWorktrees.set(name, leasedWorktreeName)
    return host
  }

  getMember(name: string, groupName?: string): MemberHost | undefined {
    if (groupName && this.memberGroups.get(name) !== groupName) return undefined
    return this.members.get(name)
  }

  // 跨重启恢复:从 group.yaml 重建所有成员(workdir/history 复用,不重新 create worktree)
  async restore(roleDefinitions?: readonly AgentRole[]): Promise<string[]> {
    if (this.scheduler.isClosed()) return []
    const restored: string[] = []
    let restoreRoles = roleDefinitions
      ? new Map(roleDefinitions.map((role) => [role.name, role]))
      : undefined
    const findRestoreRole = (name: string): AgentRole | null => {
      if (!restoreRoles) {
        try {
          restoreRoles = new Map(loadAgentRoles(agentDirs(this.repoRoot)).map((role) => [role.name, role]))
        } catch {
          restoreRoles = new Map()
        }
      }
      return restoreRoles.get(name) ?? null
    }
    for (const groupName of this.store.listGroups()) {
      const group = this.store.loadGroup(groupName)
      if (!group) continue
      const persistedMembers = [...group.members]
      const refreshedMembers: TeamMember[] = []
      for (const m of persistedMembers) {
        if (this.members.has(m.name)) {
          if (this.memberGroups.get(m.name) !== groupName) {
            console.warn(`[团队] 恢复成员 ${m.name} 失败: 成员名已属于小组 ${this.memberGroups.get(m.name)}`)
          }
          continue
        }
        try {
          await this.spawnMember(group, m.name, m.role, {
            needsApproval: m.needsApproval,
            workdir: m.workdir,
            deferGroupSave: true,
            roleDefinition: findRestoreRole(m.role),
            agentId: m.agentId,
            updatedAt: m.updatedAt,
          })
          const refreshed = group.members.find((member) => member.name === m.name)
          if (refreshed) refreshedMembers.push(refreshed)
          restored.push(`${groupName}/${m.name}`)
        } catch (e) {
          console.warn(`[团队] 恢复成员 ${m.name} 失败: ${(e as Error).message}`)
        }
      }
      const membersChanged = persistedMembers.length !== group.members.length
        || persistedMembers.some((member, index) => !sameTeamMember(member, group.members[index]))
      if (membersChanged) this.store.addMembers(group, refreshedMembers)
      try {
        this.scheduler.restoreGroup(groupName)
      } catch (error) {
        console.warn(`[团队] 恢复小组 ${groupName} 的任务失败: ${(error as Error).message}`)
      }
    }
    return restored
  }

  // Lead 读邮箱（成员发来的 IDLE/PLAN/汇报；markRead=true 时标记已读）
  readLeadMail(markRead = false): MailMessage[] {
    return this.mail.read('lead', markRead)
  }

  // Lead 审批响应：向成员发 APPROVE/DENY（成员 needsApproval 时执行前等待此消息）
  respondApproval(
    groupName: string,
    memberName: string,
    approve: boolean,
    note?: string,
    taskId?: string,
    correlationId?: string,
  ): string {
    const group = this.store.loadGroup(groupName)
    if (!group) return `审批失败: 小组不存在: ${groupName}`
    const member = group.members.find((item) => item.name === memberName)
    if (!member || this.memberGroups.get(memberName) !== groupName) {
      return `审批失败: 成员 ${memberName} 不属于小组 ${groupName}`
    }
    if (!member.needsApproval) return `审批失败: 成员 ${memberName} 不需要审批`
    const activeTasks = this.store.listTasks(groupName).filter((task) => task.assignee === memberName && task.status === 'in_progress')
    const plans = this.mail.read(group.lead).filter((message) =>
      message.from === memberName
      && message.groupId === groupName
      && message.kind === 'approval_plan'
      && message.taskId,
    )
    let plan = correlationId ? plans.find((message) => message.correlationId === correlationId) : undefined
    if (correlationId && !plan) return `审批失败: 审批关联不存在或已过期: ${correlationId}`
    if (taskId && plan?.taskId !== undefined && plan.taskId !== taskId) return '审批失败: taskId 与 correlationId 不匹配'
    const targetTaskId = taskId ?? plan?.taskId ?? (activeTasks.length === 1 ? activeTasks[0].id : undefined)
    if (!targetTaskId) return `审批失败: 无法唯一确定 ${memberName} 的待审批任务`
    const activeTask = activeTasks.find((task) => task.id === targetTaskId)
    if (!activeTask) return `审批失败: 任务 ${targetTaskId} 当前不在等待审批`
    plan ??= [...plans].reverse().find((message) => message.taskId === targetTaskId)
    if (!plan?.correlationId) return `审批失败: 任务 ${targetTaskId} 的 PLAN 尚未到达`
    const body = `${approve ? 'APPROVE' : 'DENY'} ${note ?? ''}`.trim()
    this.mail.send(group.lead, memberName, body, {
      groupId: groupName,
      kind: 'approval_decision',
      taskId: targetTaskId,
      correlationId: plan.correlationId,
    })
    return `已${approve ? '批准' : '拒绝'} ${memberName} 的任务 ${targetTaskId}${note ? `（${note}）` : ''}`
  }

  // 按工作目录反查成员身份（成员协作工具用，支持多组多成员全局注册）
  resolveMemberByCwd(cwd: string): { group: TeamGroup; member: TeamMember } | null {
    const target = resolve(cwd).toLowerCase()
    let found: { group: TeamGroup; member: TeamMember } | null = null
    for (const groupName of this.store.listGroups()) {
      const g = this.store.loadGroup(groupName)
      if (!g) continue
      for (const m of g.members) {
        if (this.memberGroups.get(m.name) !== g.name) continue
        if (resolve(m.workdir).toLowerCase() !== target) continue
        if (found) return null
        found = { group: g, member: m }
      }
    }
    return found
  }

  resolveMember(context: Pick<ToolContext, 'cwd' | 'agentId'>): { group: TeamGroup; member: TeamMember } | null {
    if (!context.agentId) return this.resolveMemberByCwd(context.cwd)
    const identity = this.memberAgents.get(context.agentId)
    if (!identity) return null
    const group = this.store.loadGroup(identity.groupName)
    const member = group?.members.find((item) => item.name === identity.memberName && item.agentId === context.agentId)
    return group && member ? { group, member } : null
  }

  private isLeadContext(context: Pick<ToolContext, 'cwd' | 'agentId'>): boolean {
    return context === this.opts.ctx
      || Boolean(context.agentId && this.opts.ctx.agentId && context.agentId === this.opts.ctx.agentId)
  }

  // 成员协作工具（全局注册一份）：执行时按 ctx.cwd 解析成员身份
  memberTools(): Tool[] {
    return createMemberTools({
      resolveMember: (context) => this.resolveMember(context),
      isLeadContext: (context) => this.isLeadContext(context),
      listTasks: (groupName) => this.store.listTasks(groupName),
      addTask: (groupName, title, assignee, dependencies, maxAttempts) =>
        this.addTask(groupName, title, assignee, dependencies, maxAttempts),
      updateTask: (groupName, memberName, taskId, patch) =>
        this.scheduler.updateTaskFromMember(groupName, memberName, taskId, patch),
      sendMail: (from, to, body) => this.mail.send(from, to, body),
    })
  }

  // Lead 指派：更新任务状态 + 触发成员执行（异步协程）
  async assignTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    return this.scheduler.assignTask(group, task, memberName)
  }

  // Lead 工具用：同步等待成员执行完成，返回执行结果（供 team_assign 工具回灌）
  // 120s 超时转后台——成员最长 15 轮×60s，不设限会挂死主对话；
  // 超时后成员完成仍会写 done（完成逻辑在 execPromise 内）
  async runTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    return this.scheduler.runTask(group, task, memberName)
  }

  listTasks(groupName: string): TeamTask[] {
    return this.scheduler.listTasks(groupName)
  }

  taskBlockers(groupName: string, task: TeamTask): string[] {
    return this.scheduler.taskBlockers(groupName, task)
  }

  cancelTask(groupName: string, taskId: string): boolean {
    return this.scheduler.cancelTask(groupName, taskId)
  }

  recoverStaleTasks(groupName: string, now = Date.now()): TeamTask[] {
    return this.scheduler.recoverStaleTasks(groupName, now)
  }

  listReadyTasks(groupName: string): TeamTask[] {
    return this.scheduler.listReadyTasks(groupName)
  }

  scheduleReadyTasks(groupName: string): string[] {
    return this.scheduler.scheduleReadyTasks(groupName)
  }

  addTask(groupName: string, title: string, assignee?: string, dependsOn: string[] = [], maxAttempts = 1, dispatchId?: string): TeamTask {
    return this.scheduler.addTask(groupName, title, assignee, dependsOn, maxAttempts, dispatchId)
  }

  // 成员空闲标记（成员自己完成后调用）
  markMemberIdle(group: TeamGroup, name: string): void {
    if (this.memberGroups.get(name) !== group.name) return
    const member = group.members.find((m) => m.name === name)
    if (member) member.status = 'idle'
    this.store.updateMemberStatus(group.name, name, 'idle')
  }

  // 全部完成后合并各成员 worktree：成员改动先 commit，再合并回主仓库
  async mergeAll(group: TeamGroup): Promise<TeamMergeResult> {
    const current = this.store.loadGroup(group.name)
    if (!current) return { success: false, output: `拒绝合并：小组不存在: ${group.name}` }
    const busy = current.members.filter((member) => this.memberGroups.get(member.name) === current.name && this.members.get(member.name)?.isBusy())
    if (busy.length > 0) return { success: false, output: `拒绝合并：成员仍在执行任务: ${busy.map((member) => member.name).join(', ')}` }
    const pending = this.store.listTasks(current.name).filter((task) => task.status === 'todo' || task.status === 'in_progress')
    if (pending.length > 0) return { success: false, output: `拒绝合并：仍有未完成任务: ${pending.map((task) => task.id).join(', ')}` }
    return mergeTeamWorktrees(current, this.worktrees, this.repoRoot)
  }

  // coordinator 开启时 Lead 工具集：移除 write/edit（保留读 + run_command + spawn）
  createLeadTools(): ReturnType<ToolRegistry['toOpenAITools']> | null {
    if (!this.isCoordinator()) return null
    return this.opts.registry
      .toOpenAITools()
      .filter((t) => t.function.name !== 'write_file' && t.function.name !== 'edit_file')
  }
}

export { TeamGroupStore } from './group.ts'
export { TeamMail } from './mail.ts'
export { MemberHost } from './member.ts'
export type { TeamGroup, TeamMember, TeamTask, TeamTaskReport, MailMessage } from './types.ts'
