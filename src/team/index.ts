import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Provider } from '../provider/types.ts'
import type { Tool, ToolContext, ToolRegistry } from '../tools/index.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import { loadAgentRoles, agentDirs } from '../subagent/loader.ts'
import type { AgentRole } from '../subagent/types.ts'
import { TeamGroupStore, indexMemberIdentities, type TeamMemberIdentityIndex } from './group.ts'
import { TeamMail } from './mail.ts'
import type { MailPage, MailPageOptions, MailRegistrationResult } from './mail.ts'
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
import { resolveOnAbort } from '../tools/abort.ts'

interface SpawnMemberOptions {
  needsApproval?: boolean
  workdir?: string
  deferGroupSave?: boolean
  roleDefinition?: AgentRole | null
  agentId?: string
  updatedAt?: number
}

interface MemberInitialization {
  name: string
  groupName: string
  lead: string
  role: string
  opts: SpawnMemberOptions
  deferMailRegistration: boolean
  promise: Promise<MemberHost>
}

interface PendingWorktreeRelease {
  worktreeName: string
  host: MemberHost | undefined
}

function sameWorkdir(left: string, right: string): boolean {
  const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return canonical(left) === canonical(right)
}

export class TeamManager {
  private store: TeamGroupStore
  private mail: TeamMail
  private members = new Map<string, MemberHost>()
  private memberGroups = new Map<string, string>()
  private memberAgents = new Map<string, { groupName: string; memberName: string }>()
  private memberWorktrees = new Map<string, string>()
  private pendingWorktreeReleases = new Map<string, PendingWorktreeRelease>()
  private worktreeReleaseTimer?: ReturnType<typeof setInterval>
  private memberInitializations = new Map<string, MemberInitialization>()
  private initializingAgents = new Map<string, MemberInitialization>()
  private repoRoot: string
  private cfgCoordinator: boolean
  private worktrees: WorktreeManager | null
  private scheduler: TeamTaskScheduler
  private restorePromise?: Promise<string[]>
  private readonly closeController = new AbortController()

  private opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext; contextWindow?: number }

  constructor(
    root: string,
    repoRoot: string,
    opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext; contextWindow?: number },
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

  private releaseMemberWorktree(memberName: string, worktreeName: string, host: MemberHost | undefined): void {
    if (!this.worktrees || this.memberWorktrees.get(memberName) !== worktreeName || this.members.get(memberName) !== host) return
    try {
      this.worktrees.release?.(worktreeName)
    } catch (error) {
      this.pendingWorktreeReleases.set(memberName, { worktreeName, host })
      if (!this.worktreeReleaseTimer) {
        this.worktreeReleaseTimer = setInterval(() => this.retryWorktreeReleases(), 1000)
        this.worktreeReleaseTimer.unref()
      }
      throw error
    }
    this.memberWorktrees.delete(memberName)
    this.pendingWorktreeReleases.delete(memberName)
    this.stopWorktreeReleaseTimer()
  }

  private stopWorktreeReleaseTimer(): void {
    if (this.pendingWorktreeReleases.size > 0) return
    clearInterval(this.worktreeReleaseTimer)
    this.worktreeReleaseTimer = undefined
  }

  private retryWorktreeReleases(): void {
    for (const [name, pending] of this.pendingWorktreeReleases) {
      if (this.memberWorktrees.get(name) !== pending.worktreeName || this.members.get(name) !== pending.host) {
        this.pendingWorktreeReleases.delete(name)
        continue
      }
      if (pending.host?.isBusy()) continue
      try { this.releaseMemberWorktree(name, pending.worktreeName, pending.host) }
      catch {}
    }
    this.stopWorktreeReleaseTimer()
  }

  async close(timeoutMs = 5000): Promise<void> {
    this.closeController.abort()
    const pending = this.scheduler.close(timeoutMs)
    for (const member of this.members.values()) member.close()
    try {
      await pending
    } finally {
      if (this.worktrees) {
        for (const [memberName, worktreeName] of this.memberWorktrees) {
          const member = this.members.get(memberName)
          if (!member?.isBusy()) {
            try { this.releaseMemberWorktree(memberName, worktreeName, member) }
            catch (error) { console.warn(`[团队] 成员 ${memberName} 释放 worktree 失败: ${(error as Error).message}`) }
            continue
          }
          void member.whenIdle().then(() => {
            this.releaseMemberWorktree(memberName, worktreeName, member)
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
    opts: SpawnMemberOptions = {},
  ): Promise<MemberHost> {
    return this.spawnMemberInternal(group, name, role, opts)
  }

  private spawnMemberInternal(
    group: TeamGroup,
    name: string,
    role: string,
    opts: SpawnMemberOptions,
    identities?: TeamMemberIdentityIndex,
    deferMailRegistration = false,
    ensureSharedArtifacts?: () => string,
  ): Promise<MemberHost> {
    if (this.scheduler.isClosed()) throw new Error('TeamManager 已关闭，无法派生成员')
    assertTeamActorName(name)
    const memberKey = teamActorKey(name)
    const pending = this.memberInitializations.get(memberKey)
    if (pending) {
      if (pending.name !== name) throw new Error(`成员名大小写冲突: ${name} 与 ${pending.name}`)
      if (pending.groupName !== group.name) throw new Error(`成员名 ${name} 已属于小组 ${pending.groupName}`)
      if (pending.lead !== group.lead || pending.role !== role
        || (opts.agentId !== undefined && opts.agentId !== pending.opts.agentId)
        || (opts.needsApproval ?? false) !== (pending.opts.needsApproval ?? false)
        || ((opts.workdir !== undefined || pending.opts.workdir !== undefined)
          && (opts.workdir === undefined || pending.opts.workdir === undefined || !sameWorkdir(opts.workdir, pending.opts.workdir)))
        || (opts.deferGroupSave ?? false) !== (pending.opts.deferGroupSave ?? false)
        || pending.deferMailRegistration !== deferMailRegistration
        || !isDeepStrictEqual(opts.roleDefinition, pending.opts.roleDefinition)) {
        throw new Error(`成员 ${name} 正在初始化，配置不同，请等待后重新读取成员`)
      }
      return pending.promise
    }
    if ([...this.members.keys()].some((current) => teamActorKey(current) === memberKey)) {
      return this.initializeMember(group, name, role, opts, identities, deferMailRegistration, ensureSharedArtifacts)
    }
    const agentId = opts.agentId ?? createRuntimeId('agent')
    if (typeof agentId !== 'string' || agentId.length === 0) throw new Error('Agent ID 必须是非空字符串')
    const agentOwner = this.initializingAgents.get(agentId)
    if (agentOwner) throw new Error(`Agent ID ${agentId} 已属于成员 ${agentOwner.name}（正在初始化）`)
    const requestOpts = { ...opts, agentId }
    const initialization: MemberInitialization = {
      name, groupName: group.name, lead: group.lead, role, opts: requestOpts, deferMailRegistration,
      promise: Promise.resolve().then(() => this.initializeMember(group, name, role, requestOpts, identities, deferMailRegistration, ensureSharedArtifacts)).finally(() => {
        if (this.memberInitializations.get(memberKey) === initialization) this.memberInitializations.delete(memberKey)
        if (this.initializingAgents.get(agentId) === initialization) this.initializingAgents.delete(agentId)
      }),
    }
    this.memberInitializations.set(memberKey, initialization)
    this.initializingAgents.set(agentId, initialization)
    return initialization.promise
  }

  private async initializeMember(
    group: TeamGroup,
    name: string,
    role: string,
    opts: SpawnMemberOptions,
    identities?: TeamMemberIdentityIndex,
    deferMailRegistration = false,
    ensureSharedArtifacts?: () => string,
  ): Promise<MemberHost> {
    if (this.scheduler.isClosed()) throw new Error('TeamManager 已关闭，无法派生成员')
    assertTeamActorName(name)
    const memberKey = teamActorKey(name)
    if (memberKey === teamActorKey(group.lead)) throw new Error(`成员名不能与负责人 ${group.lead} 相同`)
    const existingName = [...this.members.keys()].find((current) => teamActorKey(current) === memberKey)
    const existing = existingName ? this.members.get(existingName) : undefined
    if (existing) {
      const ownerGroup = this.memberGroups.get(existingName!)
      if (existingName !== name) throw new Error(`成员名大小写冲突: ${name} 与 ${existingName}`)
      if (ownerGroup === group.name) {
        const member = this.store.loadGroup(group.name, { strict: true })?.members.find((item) => item.name === name)
        if (!member || !existing.matchesMember(member) || member.role !== role
          || (opts.agentId !== undefined && opts.agentId !== member.agentId)
          || (opts.needsApproval ?? false) !== member.needsApproval
          || (opts.workdir !== undefined && !sameWorkdir(opts.workdir, member.workdir))) {
          throw new Error(`成员 ${name} 已关闭、离线或配置不同，请恢复成员后执行`)
        }
        this.store.assertMemberIdentity(group.name, member, identities)
        return existing
      }
      throw new Error(`成员名 ${name} 已属于小组 ${ownerGroup ?? '未知'}，不能加入小组 ${group.name}`)
    }
    const pendingWorktree = this.memberWorktrees.get(name)
    if (pendingWorktree) this.releaseMemberWorktree(name, pendingWorktree, undefined)
    const persistedGroup = this.store.loadGroup(group.name)
    if (!persistedGroup || persistedGroup.lead !== group.lead) throw new Error(`小组 ${group.name} 不存在或已发生变化`)
    const previous = persistedGroup.members.find((member) => member.name === name)
    const agentId = opts.agentId ?? createRuntimeId('agent')
    const agentOwner = this.memberAgents.get(agentId)
    if (agentOwner && (agentOwner.groupName !== group.name || agentOwner.memberName !== name)) {
      throw new Error(`Agent ID ${agentId} 已属于成员 ${agentOwner.memberName}`)
    }
    this.store.assertMemberIdentity(group.name, { name, agentId }, identities)
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
    const sharedArtifacts = ensureSharedArtifacts ? ensureSharedArtifacts() : projectStatePath(this.repoRoot, 'artifacts')
    if (!ensureSharedArtifacts) mkdirSync(sharedArtifacts, { recursive: true })
    // 成员独立 worktree（分支 wt-member-<name>），写文件不污染主仓库
    // 恢复场景(opts.workdir):复用已记录的 workdir,不重新 create
    let workdir = opts.workdir ?? this.repoRoot
    let createdWorktreeName: string | undefined
    let leasedWorktreeName: string | undefined
    if (!opts.workdir && this.worktrees) {
      const worktreeName = `member-${name}`
      try {
        const wt = await this.worktrees.create(worktreeName)
        workdir = wt.path
        leasedWorktreeName = worktreeName
        if (wt.created === true) createdWorktreeName = worktreeName
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
      if (this.scheduler.isClosed()) throw new Error('TeamManager 已关闭，无法派生成员')
      if (!deferMailRegistration) this.mail.register(name)
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
          contextWindow: this.opts.contextWindow,
        },
      )
      if (opts.deferGroupSave) {
        group.members = group.members.filter((current) => current.name !== member.name)
        group.members.push(member)
      } else {
        if (!this.store.publishMember(persistedGroup, member, previous)) throw new Error(`成员 ${name} 初始化期间花名册已发生变化，请重新读取后派生`)
        Object.assign(group, persistedGroup)
      }
    } catch (error) {
      if (createdWorktreeName && this.worktrees) {
        try {
          const rollback = await this.worktrees.remove(createdWorktreeName)
          if (!rollback.startsWith('已删除')) console.warn(`[团队] 成员 ${name} 初始化失败，worktree 回滚未完成: ${rollback}`)
        } catch (rollbackError) {
          console.warn(`[团队] 成员 ${name} 初始化失败，worktree 回滚异常: ${(rollbackError as Error).message}`)
        }
      }
      if (leasedWorktreeName && this.worktrees) {
        this.memberWorktrees.set(name, leasedWorktreeName)
        try { this.releaseMemberWorktree(name, leasedWorktreeName, undefined) }
        catch (releaseError) { console.warn(`[团队] 成员 ${name} 初始化失败，worktree 释放异常: ${(releaseError as Error).message}`) }
      }
      throw error
    }
    this.memberGroups.set(name, group.name)
    this.memberAgents.set(member.agentId!, { groupName: group.name, memberName: name })
    this.members.set(name, host)
    if (leasedWorktreeName) this.memberWorktrees.set(name, leasedWorktreeName)
    return host
  }

  private async discardRestoredMember(name: string, host: MemberHost): Promise<void> {
    if (this.members.get(name) !== host) return
    host.close()
    await resolveOnAbort(() => host.whenIdle(), this.closeController.signal, undefined)
    if (host.isBusy() || this.members.get(name) !== host || !host.persistPendingHistory()) return
    const groupName = this.memberGroups.get(name)
    const worktreeName = this.memberWorktrees.get(name)
    if (worktreeName) {
      try {
        this.releaseMemberWorktree(name, worktreeName, host)
      } catch (error) {
        console.warn(`[团队] 成员 ${name} 释放 worktree 失败: ${(error as Error).message}`)
        return
      }
    }
    this.members.delete(name)
    this.memberGroups.delete(name)
    for (const [agentId, identity] of this.memberAgents) {
      if (identity.memberName === name && identity.groupName === groupName) this.memberAgents.delete(agentId)
    }
  }

  getMember(name: string, groupName?: string): MemberHost | undefined {
    if (groupName && this.memberGroups.get(name) !== groupName) return undefined
    return this.members.get(name)
  }

  // 跨重启恢复:从 group.yaml 重建所有成员(workdir/history 复用,不重新 create worktree)
  restore(roleDefinitions?: readonly AgentRole[]): Promise<string[]> {
    if (this.scheduler.isClosed()) return Promise.resolve([])
    if (this.restorePromise) return this.restorePromise
    const pending = this.restoreCurrentMembers(roleDefinitions).finally(() => {
      if (this.restorePromise === pending) this.restorePromise = undefined
    })
    this.restorePromise = pending
    return pending
  }

  private async restoreCurrentMembers(roleDefinitions?: readonly AgentRole[]): Promise<string[]> {
    if (this.scheduler.isClosed()) return []
    const restored: string[] = []
    const groups: Array<[string, TeamGroup]> = []
    const unreadableGroups = new Set<string>()
    for (const groupName of this.store.listGroups({ refresh: true })) {
      let group: TeamGroup | null
      try { group = this.store.loadGroup(groupName, { strict: true }) }
      catch (error) {
        unreadableGroups.add(groupName)
        console.warn(`[团队] 恢复小组 ${groupName} 的花名册失败: ${(error as Error).message}`)
        continue
      }
      if (!group) continue
      groups.push([groupName, group])
    }
    const currentGroups = new Map(groups)
    const identities = indexMemberIdentities(currentGroups.values())
    for (const [name, host] of this.members) {
      const groupName = this.memberGroups.get(name)!
      if (unreadableGroups.has(groupName)) continue
      const member = currentGroups.get(groupName)?.members.find((item) => item.name === name)
      let identityValid = false
      if (member) {
        try { this.store.assertMemberIdentity(groupName, member, identities); identityValid = true }
        catch (error) { console.warn(`[团队] 成员 ${name} 身份冲突: ${(error as Error).message}`) }
      }
      if (member && identityValid && host.matchesMember(member)) continue
      await this.discardRestoredMember(name, host)
      if (this.scheduler.isClosed()) return []
    }
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
    const prepared: Array<{ groupName: string; name: string; member: TeamMember; previous: TeamMember; host: MemberHost }> = []
    let restoreArtifacts: string | undefined
    const ensureRestoreArtifacts = (): string => {
      if (!restoreArtifacts) {
        const path = projectStatePath(this.repoRoot, 'artifacts')
        mkdirSync(path, { recursive: true })
        restoreArtifacts = path
      }
      return restoreArtifacts
    }
    for (const [groupName, group] of groups) {
      const persistedMembers = [...group.members]
      for (const m of persistedMembers) {
        if (this.members.has(m.name)) {
          if (this.memberGroups.get(m.name) !== groupName) {
            console.warn(`[团队] 恢复成员 ${m.name} 失败: 成员名已属于小组 ${this.memberGroups.get(m.name)}`)
          }
          continue
        }
        try {
          const host = await this.spawnMemberInternal(group, m.name, m.role, {
            needsApproval: m.needsApproval,
            workdir: m.workdir,
            deferGroupSave: true,
            roleDefinition: findRestoreRole(m.role),
            agentId: m.agentId,
            updatedAt: m.updatedAt,
          }, identities, true, ensureRestoreArtifacts)
          const refreshed = group.members.find((member) => member.name === m.name)
          if (refreshed?.agentId) prepared.push({ groupName, name: m.name, member: refreshed, previous: m, host })
        } catch (e) {
          console.warn(`[团队] 恢复成员 ${m.name} 失败: ${(e as Error).message}`)
        }
      }
    }
    if (this.scheduler.isClosed()) {
      for (const member of prepared) await this.discardRestoredMember(member.name, member.host)
      return []
    }
    let mailRegistration: MailRegistrationResult
    try {
      mailRegistration = this.mail.registerMany(prepared.map((member) => member.name))
    } catch (error) {
      console.warn(`[团队] 批量注册邮箱失败，改为逐个注册: ${(error as Error).message}`)
      mailRegistration = { registered: new Set(), failures: new Map() }
      for (const member of prepared) {
        try {
          this.mail.register(member.name)
          mailRegistration.registered.add(member.name)
        } catch (registrationError) {
          mailRegistration.failures.set(member.name, registrationError as Error)
        }
      }
    }
    const accepted = new Map<string, typeof prepared>()
    for (const member of prepared) {
      if (!mailRegistration.registered.has(member.name)) {
        const failure = mailRegistration.failures.get(member.name)
        console.warn(`[团队] 恢复成员 ${member.name} 失败: ${failure?.message ?? '邮箱注册失败'}`)
        await this.discardRestoredMember(member.name, member.host)
        continue
      }
      let groupMembers = accepted.get(member.groupName)
      if (!groupMembers) {
        groupMembers = []
        accepted.set(member.groupName, groupMembers)
      }
      groupMembers.push(member)
    }
    for (const [groupName, group] of groups) {
      const groupMembers = accepted.get(groupName) ?? []
      let committed = new Set<string>()
      try {
        if (!this.scheduler.isClosed()) committed = this.store.restoreMembers(group, groupMembers)
      } catch (error) { console.warn(`[团队] 恢复小组 ${groupName} 的成员失败: ${(error as Error).message}`) }
      for (const member of groupMembers) {
        if (committed.has(member.name)) restored.push(`${groupName}/${member.name}`)
        else await this.discardRestoredMember(member.name, member.host)
      }
      if (this.scheduler.isClosed()) continue
      try {
        this.scheduler.restoreGroup(groupName)
      } catch (error) {
        console.warn(`[团队] 恢复小组 ${groupName} 的任务失败: ${(error as Error).message}`)
      }
    }
    return this.scheduler.isClosed() ? [] : restored
  }

  // Lead 读邮箱（成员发来的 IDLE/PLAN/汇报；markRead=true 时标记已读）
  readLeadMail(markRead = false, groupName?: string): MailMessage[] {
    return this.mail.read(this.leadMailbox(groupName), markRead)
  }

  readLeadMailPage(options: MailPageOptions = {}, groupName?: string): MailPage {
    return this.mail.readPage(this.leadMailbox(groupName), options)
  }

  private leadMailbox(groupName?: string): string {
    if (groupName === undefined) return 'lead'
    const group = this.store.loadGroup(groupName, { strict: true })
    if (!group) throw new Error(`小组不存在: ${groupName}`)
    return group.lead
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
    try {
      return this.store.withMemberLock(() => {
        if (this.isClosed()) return '审批失败: TeamManager 已关闭'
        const group = this.store.loadGroup(groupName, { strict: true })
        if (!group) return `审批失败: 小组不存在: ${groupName}`
        const member = group.members.find((item) => item.name === memberName)
        if (!member || this.memberGroups.get(memberName) !== groupName) return `审批失败: 成员 ${memberName} 不属于小组 ${groupName}`
        if (!member.needsApproval) return `审批失败: 成员 ${memberName} 不需要审批`
        const host = this.members.get(memberName)
        if (!host?.matchesMember(member) || !this.store.isMemberIdentityUnique(groupName, member)) return `审批失败: 成员 ${memberName} 身份已失效或冲突`
        const request = host.getApprovalRequest()
        if (!request || request.lead !== group.lead) return `审批失败: 成员 ${memberName} 当前不在等待审批`
        if (taskId && taskId !== request.taskId) return '审批失败: taskId 与当前审批请求不匹配'
        if (correlationId && correlationId !== request.correlationId) return `审批失败: 审批关联不存在或已过期: ${correlationId}`
        return this.store.withTaskLock(groupName, (tasks) => {
          const task = tasks.find((task) => task.id === request.taskId)
          if (!task || task.status !== 'in_progress' || task.assignee !== memberName
            || !request.leaseId || task.leaseId !== request.leaseId || task.activeAgentId !== member.agentId
            || (task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= Date.now())) return `审批失败: 任务 ${request.taskId} 的审批请求已过期`
          const plan = this.mail.read(group.lead).find((message) => message.from === memberName && message.to === group.lead
            && message.groupId === groupName && message.kind === 'approval_plan'
            && message.taskId === request.taskId && message.correlationId === request.correlationId && /^PLAN(?:\s|$)/.test(message.body))
          if (!plan) return `审批失败: 任务 ${request.taskId} 的 PLAN 尚未到达`
          if (!host.sendApprovalDecision(request, approve, note)) return `审批失败: 成员 ${memberName} 当前不在等待审批`
          return `已${approve ? '批准' : '拒绝'} ${memberName} 的任务 ${request.taskId}${note ? `（${note}）` : ''}`
        })
      })
    } catch (error) { return `审批失败: ${error instanceof Error ? error.message : String(error)}` }
  }

  resolveMemberByCwd(cwd: string): { group: TeamGroup; member: TeamMember } | null {
    return this.resolveMember({ cwd })
  }

  resolveMember(context: Pick<ToolContext, 'cwd' | 'agentId'>): { group: TeamGroup; member: TeamMember } | null {
    if (this.isClosed()) return null
    let identity = context.agentId ? this.memberAgents.get(context.agentId) : undefined
    if (context.agentId && !identity) return null
    if (!context.agentId) {
      const candidates = [...this.members].filter(([, host]) => sameWorkdir(host.getWorkdir(), context.cwd))
      if (candidates.length !== 1) return null
      const memberName = candidates[0][0], groupName = this.memberGroups.get(memberName)
      if (!groupName) return null
      identity = { groupName, memberName }
    }
    if (!identity) return null
    const target = identity
    const groups: TeamGroup[] = []
    for (const name of this.store.listGroups({ refresh: true })) {
      const group = this.store.loadGroup(name, { strict: true })
      if (group) groups.push(group)
    }
    const identities = indexMemberIdentities(groups)
    const group = groups.find((group) => group.name === target.groupName)
    const member = group?.members.find((member) => member.name === target.memberName)
    if (!group || !member || this.memberGroups.get(member.name) !== group.name
      || !this.members.get(member.name)?.matchesMember(member)
      || (context.agentId && member.agentId !== context.agentId)) return null
    try { this.store.assertMemberIdentity(group.name, member, identities) }
    catch { return null }
    return { group, member }
  }

  private isLeadContext(context: Pick<ToolContext, 'cwd' | 'agentId'>): boolean {
    return !this.isClosed() && (context === this.opts.ctx
      || Boolean(context.agentId && this.opts.ctx.agentId && context.agentId === this.opts.ctx.agentId))
  }

  memberTools(): Tool[] {
    return createMemberTools({
      withContext: (_context, operation) => this.store.withMemberLock(operation),
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
    if (!member || !this.members.get(name)?.matchesMember(member)) return
    const updated = this.store.updateMemberStatus(group.name, name, 'idle', member)
    if (updated) Object.assign(member, updated)
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
