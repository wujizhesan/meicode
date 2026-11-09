import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'yaml'
import type { MailMessage, TeamGroup, TeamMember, TeamTask, TeamTaskReport, TeamTaskSettlement } from './types.ts'
import { writeTextAtomicSync } from '../tools/atomic-write.ts'
import { withLock } from './lock.ts'
import { atomicWriteFile } from './atomic.ts'
import { assertTeamActorName, isTeamActorName, teamActorKey } from './validation.ts'

interface CachedTeamGroup {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  group: TeamGroup
}

interface TeamMemberIdentity {
  groupName: string
  memberName: string
}

export interface TeamMemberIdentityIndex {
  names: ReadonlyMap<string, readonly TeamMemberIdentity[]>
  agents: ReadonlyMap<string, readonly TeamMemberIdentity[]>
}

export function indexMemberIdentities(groups: Iterable<TeamGroup>) {
  const names = new Map<string, TeamMemberIdentity[]>(), agents = new Map<string, TeamMemberIdentity[]>()
  for (const group of groups) for (const member of group.members) {
    const identity = { groupName: group.name, memberName: member.name }, key = teamActorKey(member.name)
    names.set(key, [...(names.get(key) ?? []), identity])
    if (member.agentId) agents.set(member.agentId, [...(agents.get(member.agentId) ?? []), identity])
  }
  return { names, agents }
}

function replaceIndexedMember(index: ReturnType<typeof indexMemberIdentities>, groupName: string, previous: TeamMember, member: TeamMember): void {
  const remove = (map: Map<string, TeamMemberIdentity[]>, key: string) => {
    const owners = (map.get(key) ?? []).filter((owner) => owner.groupName !== groupName || owner.memberName !== previous.name)
    if (owners.length) map.set(key, owners)
    else map.delete(key)
  }
  remove(index.names, teamActorKey(previous.name))
  if (previous.agentId) remove(index.agents, previous.agentId)
  const identity = { groupName, memberName: member.name }, key = teamActorKey(member.name)
  index.names.set(key, [...(index.names.get(key) ?? []), identity])
  if (member.agentId) index.agents.set(member.agentId, [...(index.agents.get(member.agentId) ?? []), identity])
}

interface CachedTeamTasks {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  tasks: TeamTask[]
}

function sameTaskSnapshot(cached: CachedTeamTasks, stats: Stats): boolean {
  return cached.size === stats.size
    && cached.mtimeMs === stats.mtimeMs
    && cached.ctimeMs === stats.ctimeMs
    && cached.ino === stats.ino
}

function taskSnapshot(stats: Stats, tasks: TeamTask[]): CachedTeamTasks {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, tasks }
}

interface CachedGroupList {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  nlink: number
  groups: string[]
}

function cloneGroup(group: TeamGroup): TeamGroup {
  return { ...group, members: group.members.map((member) => ({ ...member })) }
}

function cloneTask(task: TeamTask): TeamTask {
  const report = task.report
  return {
    ...task,
    ...(task.notifications ? { notifications: task.notifications.map((message) => ({ ...message })) } : {}),
    depends_on: task.depends_on ? [...task.depends_on] : undefined,
    report: report ? {
      ...report,
      artifacts: report.artifacts ? [...report.artifacts] : undefined,
      changedFiles: report.changedFiles ? [...report.changedFiles] : undefined,
      tests: report.tests?.map((test) => ({ ...test })),
      evidence: report.evidence ? {
        ...report.evidence,
        files: [...report.evidence.files],
        commands: [...report.evidence.commands],
        artifacts: [...report.evidence.artifacts],
        changedFiles: [...report.evidence.changedFiles],
        tests: report.evidence.tests.map((test) => ({ ...test })),
      } : undefined,
    } : undefined,
  }
}

function cloneTasks(tasks: TeamTask[]): TeamTask[] {
  return tasks.map(cloneTask)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isTeamMember(value: unknown): value is TeamMember {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const member = value as Record<string, unknown>
  return typeof member.name === 'string'
    && isTeamActorName(member.name)
    && typeof member.role === 'string'
    && member.role.length > 0
    && typeof member.workdir === 'string'
    && member.workdir.length > 0
    && member.backend === 'coroutine'
    && typeof member.needsApproval === 'boolean'
    && (member.status === 'idle' || member.status === 'busy' || member.status === 'offline')
    && isOptionalString(member.agentId)
    && isOptionalNumber(member.updatedAt)
}

function parseGroupFile(file: string, expectedName?: string): TeamGroup {
  const raw = readFileSync(file, 'utf8')
  let value: unknown
  try {
    value = parse(raw)
  } catch (error) {
    throw new Error(`小组文件损坏，已拒绝覆盖: ${file}（${(error as Error).message}）`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`小组文件损坏，已拒绝覆盖: ${file}`)
  const group = value as Record<string, unknown>
  if (typeof group.name !== 'string' || !TeamGroupStore.validName(group.name)) throw new Error(`小组文件名称非法: ${file}`)
  if (expectedName && group.name !== expectedName) throw new Error(`小组文件名称不匹配: ${group.name} != ${expectedName}`)
  if (typeof group.lead !== 'string' || !isTeamActorName(group.lead)) throw new Error(`小组负责人非法: ${file}`)
  if (!Array.isArray(group.members) || !group.members.every(isTeamMember)) throw new Error(`小组成员结构非法: ${file}`)
  const memberKeys = new Set<string>()
  for (const member of group.members) {
    const key = teamActorKey(member.name)
    if (key === teamActorKey(group.lead) || memberKeys.has(key)) throw new Error(`小组成员名称冲突: ${file}`)
    memberKeys.add(key)
  }
  return group as unknown as TeamGroup
}

function assertTeamGroup(group: TeamGroup): void {
  const serialized = stringify(group)
  const parsed = parse(serialized) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('非法小组结构')
  const value = parsed as Record<string, unknown>
  if (typeof value.name !== 'string' || !TeamGroupStore.validName(value.name)) throw new Error('非法小组名称')
  if (typeof value.lead !== 'string' || !isTeamActorName(value.lead)) throw new Error('非法小组负责人')
  if (!Array.isArray(value.members) || !value.members.every(isTeamMember)) throw new Error('非法小组成员结构')
  const memberKeys = new Set<string>()
  for (const member of value.members as TeamMember[]) {
    const key = teamActorKey(member.name)
    if (key === teamActorKey(value.lead) || memberKeys.has(key)) throw new Error('小组成员名称冲突')
    memberKeys.add(key)
  }
}

function isTaskReport(value: unknown): value is TeamTaskReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  if (typeof report.reportId !== 'string' || !report.reportId) return false
  if (report.status !== 'done' && report.status !== 'failed' && report.status !== 'cancelled') return false
  if (typeof report.summary !== 'string') return false
  if (!isOptionalNumber(report.tokens) || !isOptionalNumber(report.durationMs) || !isOptionalString(report.error)) return false
  if (report.artifacts !== undefined && !isStringArray(report.artifacts)) return false
  if (report.changedFiles !== undefined && !isStringArray(report.changedFiles)) return false
  if (report.tests !== undefined && (!Array.isArray(report.tests) || !report.tests.every((test) => {
    if (!test || typeof test !== 'object' || Array.isArray(test)) return false
    const item = test as Record<string, unknown>
    return typeof item.command === 'string' && typeof item.passed === 'boolean' && isOptionalString(item.output)
  }))) return false
  if (report.evidence !== undefined) {
    if (!report.evidence || typeof report.evidence !== 'object' || Array.isArray(report.evidence)) return false
    const evidence = report.evidence as Record<string, unknown>
    if (!isStringArray(evidence.files) || !isStringArray(evidence.commands) || !isStringArray(evidence.artifacts) || !isStringArray(evidence.changedFiles)) return false
    if (!Array.isArray(evidence.tests) || !evidence.tests.every((test) => {
      if (!test || typeof test !== 'object' || Array.isArray(test)) return false
      const item = test as Record<string, unknown>
      return typeof item.command === 'string' && typeof item.passed === 'boolean' && isOptionalString(item.output)
    })) return false
  }
  return true
}

function isTaskSettlement(value: unknown): value is TeamTaskSettlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<TeamTaskSettlement>
  if ((entry.kind !== 'cancel' && entry.kind !== 'result')
    || typeof entry.groupName !== 'string' || !TeamGroupStore.validName(entry.groupName)
    || typeof entry.taskId !== 'string' || !entry.taskId
    || typeof entry.memberName !== 'string' || !isTeamActorName(entry.memberName)
    || typeof entry.reportId !== 'string' || !entry.reportId) return false
  for (const key of ['leaseId', 'agentId', 'sessionId', 'parentAgentId'] as const) {
    if (!isOptionalString(entry[key])) return false
  }
  if (entry.requeueOnShutdown !== undefined && typeof entry.requeueOnShutdown !== 'boolean') return false
  if (entry.kind === 'cancel') {
    if (entry.result !== undefined || entry.requeueOnShutdown !== undefined) return false
    if (entry.queuedTask === undefined) return true
    const snapshot = entry.queuedTask
    return entry.leaseId === undefined && Boolean(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot))
      && typeof snapshot.title === 'string' && Boolean(snapshot.title)
      && (snapshot.assignee === undefined || (snapshot.assignee === entry.memberName && isTeamActorName(snapshot.assignee)))
      && isOptionalNumber(snapshot.attempt) && (snapshot.attempt === undefined || Number.isSafeInteger(snapshot.attempt))
      && isOptionalNumber(snapshot.updatedAt) && isOptionalString(snapshot.reportId)
  }
  if (entry.queuedTask !== undefined) return false
  return typeof entry.leaseId === 'string' && Boolean(entry.leaseId)
    && Boolean(entry.result && (entry.result.status === 'done' || entry.result.status === 'failed')
      && (entry.result.interrupted === undefined || typeof entry.result.interrupted === 'boolean')
      && (entry.result.interrupted !== true || entry.result.status === 'failed')
      && typeof entry.result.text === 'string' && isTaskReport(entry.result.report)
      && entry.result.report.status === entry.result.status && entry.result.report.reportId === entry.reportId
      && (!entry.requeueOnShutdown || entry.result.status === 'failed'))
}

function isTaskNotification(value: unknown, taskId: string): value is MailMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Partial<MailMessage>
  return typeof message.messageId === 'string' && Boolean(message.messageId)
    && typeof message.groupId === 'string' && TeamGroupStore.validName(message.groupId)
    && message.taskId === taskId
    && typeof message.correlationId === 'string' && Boolean(message.correlationId)
    && (message.kind === 'task_result' || message.kind === 'task_retry' || message.kind === 'task_cancelled')
    && typeof message.from === 'string' && isTeamActorName(message.from)
    && typeof message.to === 'string' && isTeamActorName(message.to)
    && typeof message.body === 'string'
    && typeof message.ts === 'number' && Number.isFinite(message.ts) && message.ts >= 0
    && typeof message.read === 'boolean' && isOptionalString(message.summary)
}

function isTeamTask(value: unknown): value is TeamTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  if (typeof task.id !== 'string' || !task.id || typeof task.title !== 'string' || !task.title) return false
  if (task.status !== 'todo' && task.status !== 'in_progress' && task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled') return false
  for (const key of ['assignee', 'dispatchId', 'activeAgentId', 'reportId', 'leaseId', 'lastError', 'result'] as const) {
    if (!isOptionalString(task[key])) return false
  }
  for (const key of ['createdAt', 'updatedAt', 'attempt', 'maxAttempts', 'leaseExpiresAt', 'nextRetryAt'] as const) {
    if (!isOptionalNumber(task[key])) return false
  }
  const attempt = task.attempt
  const maxAttempts = task.maxAttempts
  if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isSafeInteger(attempt))) return false
  if (maxAttempts !== undefined && (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) return false
  if (task.depends_on !== undefined && !isStringArray(task.depends_on)) return false
  if (task.report !== undefined && !isTaskReport(task.report)) return false
  if (task.notifications !== undefined && (!Array.isArray(task.notifications)
    || !task.notifications.every((message) => isTaskNotification(message, task.id as string)))) return false
  return true
}

function assertTaskList(value: unknown, groupName: string): asserts value is TeamTask[] {
  if (!Array.isArray(value)) throw new Error('根节点不是数组')
  const taskIds = new Set<string>(), notificationIds = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const task: unknown = value[index]
    if (!isTeamTask(task)) throw new Error(`第 ${index + 1} 项不是合法任务`)
    if (taskIds.has(task.id)) throw new Error(`任务 ID 重复: ${task.id}`)
    taskIds.add(task.id)
    for (const message of task.notifications ?? []) {
      if (message.groupId !== groupName) throw new Error(`任务 ${task.id} 通知小组不匹配: ${message.groupId} != ${groupName}`)
      const key = JSON.stringify([teamActorKey(message.to), message.messageId])
      if (notificationIds.has(key)) throw new Error(`任务通知 ID 重复: ${message.messageId} -> ${message.to}`)
      notificationIds.add(key)
    }
  }
}

function parseTaskFile(file: string, groupName: string): TeamTask[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    assertTaskList(value, groupName)
    return value
  } catch (error) {
    throw new Error(`任务文件损坏，已拒绝覆盖: ${file}（${(error as Error).message}）`)
  }
}

export class TeamGroupStore {
  private root: string // <cwd>/.meicode/team
  private groupCache = new Map<string, CachedTeamGroup>()
  private taskCache = new Map<string, CachedTeamTasks>()
  private groupListCache?: CachedGroupList
  private memberLockHeld = false

  constructor(root: string) {
    this.root = root
  }

  private cacheWrittenTasks(file: string, tasks: TeamTask[], groupName: string): void {
    try {
      const stats = statSync(file)
      assertTaskList(tasks, groupName)
      this.taskCache.set(file, taskSnapshot(stats, cloneTasks(tasks)))
    } catch {
      this.taskCache.delete(file)
    }
  }

  groupDir(name: string): string {
    if (!TeamGroupStore.validName(name)) throw new Error(`非法团队名称: ${name}`)
    return join(this.root, name)
  }

  private settlementFile(entry: TeamTaskSettlement, legacy = false): string {
    const snapshot = entry.queuedTask
    const identity = snapshot
      ? [entry.kind, entry.taskId, entry.leaseId, snapshot.title, snapshot.assignee, snapshot.attempt, snapshot.updatedAt, snapshot.reportId]
      : [entry.kind, entry.taskId, entry.leaseId]
    if (!legacy) identity.push(entry.reportId)
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    return join(this.groupDir(entry.groupName), 'tasks.pending', `${key}.json`)
  }

  saveTaskSettlement(entry: TeamTaskSettlement): void {
    if (!isTaskSettlement(entry)) throw new Error('非法团队任务补存记录')
    const file = this.settlementFile(entry)
    mkdirSync(dirname(file), { recursive: true })
    withLock(join(this.groupDir(entry.groupName), 'tasks.lock'), () => {
      withLock(join(dirname(file), 'settlements.lock'), () => {
        const destination = join(realpathSync.native(dirname(file)), basename(file))
        writeTextAtomicSync(destination, JSON.stringify(entry), { cwd: this.root })
      })
    })
  }

  loadTaskSettlements(groupName: string): TeamTaskSettlement[] {
    const directory = join(this.groupDir(groupName), 'tasks.pending')
    try { statSync(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries = new Map<string, TeamTaskSettlement>()
    withLock(join(directory, 'settlements.lock'), () => {
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.json')) continue
        const file = join(directory, name)
        let raw: string
        try { raw = readFileSync(file, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        let entry: unknown
        try { entry = JSON.parse(raw) }
        catch { }
        if (!isTaskSettlement(entry) || entry.groupName !== groupName
          || (this.settlementFile(entry) !== file && this.settlementFile(entry, true) !== file)) {
          try { renameSync(file, `${file}.corrupt.${randomUUID()}`) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          continue
        }
        const key = this.settlementFile(entry)
        if (!entries.has(key) || file === key) entries.set(key, entry)
      }
    })
    return [...entries.values()].sort((a, b) => Number(a.kind !== 'cancel') - Number(b.kind !== 'cancel'))
  }

  deleteTaskSettlement(entry: TeamTaskSettlement): void {
    if (!isTaskSettlement(entry)) throw new Error('非法团队任务补存记录')
    const directory = dirname(this.settlementFile(entry))
    try { statSync(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const snapshot: unknown = JSON.parse(JSON.stringify(entry))
    withLock(join(directory, 'settlements.lock'), () => {
      for (const file of [this.settlementFile(entry), this.settlementFile(entry, true)]) {
        let raw: string
        try { raw = readFileSync(file, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        let current: unknown
        try { current = JSON.parse(raw) }
        catch { continue }
        if (!isDeepStrictEqual(current, snapshot)) continue
        try { unlinkSync(file) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    })
  }

  static validName(name: string): boolean {
    return Boolean(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
  }

  withMemberLock<T>(fn: () => T): T {
    // 成员工具完成依赖任务时会在同一同步调用内再次领取。
    if (this.memberLockHeld) return fn()
    let result!: T
    withLock(join(this.root, '_shared', 'members.lock'), () => {
      this.memberLockHeld = true
      try { result = fn() }
      finally { this.memberLockHeld = false }
    })
    return result
  }

  private withGroupLock(name: string, fn: () => void): void {
    this.withMemberLock(() => withLock(join(this.groupDir(name), 'group.lock'), fn))
  }

  private memberIdentityIndex(options: { strict?: boolean } = {}) {
    const groups: TeamGroup[] = []
    for (const name of this.listGroupNames(true)) {
      const group = this.loadGroup(name, options)
      if (group) groups.push(group)
    }
    return indexMemberIdentities(groups)
  }

  isMemberIdentityUnique(groupName: string, member: Pick<TeamMember, 'name' | 'agentId'>): boolean {
    const identities = this.memberIdentityIndex({ strict: true })
    try { this.assertMemberIdentity(groupName, member, identities); return true }
    catch { return false }
  }

  assertMemberIdentity(groupName: string, member: Pick<TeamMember, 'name' | 'agentId'>, index: TeamMemberIdentityIndex = this.memberIdentityIndex()): void {
    const names = index.names.get(teamActorKey(member.name)) ?? []
    const caseConflict = names.find((owner) => owner.memberName !== member.name)
    if (caseConflict) throw new Error(`成员名大小写冲突: ${member.name} 与 ${caseConflict.memberName}`)
    const nameOwner = names.find((owner) => owner.groupName !== groupName)
    if (nameOwner) throw new Error(`成员名 ${member.name} 已属于小组 ${nameOwner.groupName}`)
    if (!member.agentId) return
    const agentOwner = index.agents.get(member.agentId)?.find((owner) => owner.groupName !== groupName || owner.memberName !== member.name)
    if (agentOwner) throw new Error(`Agent ID ${member.agentId} 已属于成员 ${agentOwner.groupName}/${agentOwner.memberName}`)
  }

  createGroup(name: string, lead: string): TeamGroup {
    assertTeamActorName(lead, '负责人名')
    const dir = this.groupDir(name)
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'mail'), { recursive: true })
    mkdirSync(join(dir, 'members'), { recursive: true })
    const groupFile = join(dir, 'group.yaml')
    const tasksFile = join(dir, 'tasks.json')
    let group: TeamGroup | null = null
    this.withGroupLock(name, () => {
      if (existsSync(groupFile)) {
        const persisted = parseGroupFile(groupFile, name)
        if (persisted.lead !== lead) throw new Error(`小组 ${name} 已存在，负责人为 ${persisted.lead}`)
        group = persisted
      } else {
        group = { name, lead, members: [] }
        atomicWriteFile(groupFile, stringify(group))
      }
      if (!existsSync(tasksFile)) atomicWriteFile(tasksFile, '[]')
    })
    this.groupCache.delete(groupFile)
    this.taskCache.delete(tasksFile)
    this.groupListCache = undefined
    return cloneGroup(group!)
  }

  loadGroup(name: string, options: { strict?: boolean } = {}): TeamGroup | null {
    if (!TeamGroupStore.validName(name)) return null
    const file = join(this.groupDir(name), 'group.yaml')
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(file)
    } catch (error) {
      this.groupCache.delete(file)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    }
    const cached = this.groupCache.get(file)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
      return cloneGroup(cached.group)
    }
    try {
      const group = parseGroupFile(file, name)
      this.groupCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, group })
      return cloneGroup(group)
    } catch (error) {
      this.groupCache.delete(file)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && (options.strict || code !== undefined)) throw error
      return null
    }
  }

  saveGroup(group: TeamGroup): void {
    assertTeamGroup(group)
    const dir = this.groupDir(group.name)
    const file = join(dir, 'group.yaml')
    this.withGroupLock(group.name, () => atomicWriteFile(file, stringify(group)))
    this.groupCache.delete(file)
  }

  mutateGroup(name: string, mutator: (group: TeamGroup) => void | boolean): TeamGroup | null {
    const dir = this.groupDir(name)
    let updated: TeamGroup | null = null
    this.withGroupLock(name, () => {
      const file = join(dir, 'group.yaml')
      if (!existsSync(file)) return
      let group: TeamGroup
      try {
        group = parseGroupFile(file, name)
      } catch {
        return
      }
      if (mutator(group) === false) { updated = group; return }
      assertTeamGroup(group)
      atomicWriteFile(file, stringify(group))
      this.groupCache.delete(file)
      updated = group
    })
    return updated
  }

  addMember(group: TeamGroup, member: TeamMember): void {
    this.addMembers(group, [member])
  }

  addMembers(group: TeamGroup, members: TeamMember[]): void {
    if (members.length === 0) return
    const memberKeys = new Set<string>()
    for (const member of members) {
      assertTeamActorName(member.name)
      const key = teamActorKey(member.name)
      if (key === teamActorKey(group.lead)) throw new Error(`成员名不能与负责人 ${group.lead} 相同`)
      if (memberKeys.has(key)) throw new Error(`成员名大小写冲突或重复: ${member.name}`)
      memberKeys.add(key)
    }
    const updated = this.mutateGroup(group.name, (current) => {
      for (const member of members) {
        const conflict = current.members.find((existing) => teamActorKey(existing.name) === teamActorKey(member.name) && existing.name !== member.name)
        if (conflict) throw new Error(`成员名大小写冲突: ${member.name} 与 ${conflict.name}`)
      }
      current.members = current.members.filter((member) => !memberKeys.has(teamActorKey(member.name)))
      current.members.push(...members.map((member) => ({ ...member })))
    })
    if (!updated) throw new Error(`小组 ${group.name} 不存在或文件损坏`)
    Object.assign(group, updated)
  }

  publishMember(group: TeamGroup, member: TeamMember, previous: Readonly<TeamMember> | undefined): boolean {
    let published = false
    const dir = this.groupDir(group.name)
    this.withGroupLock(group.name, () => {
      const file = join(dir, 'group.yaml')
      if (!existsSync(file)) throw new Error(`小组 ${group.name} 不存在或文件损坏`)
      const current = parseGroupFile(file, group.name)
      const index = current.members.findIndex((item) => teamActorKey(item.name) === teamActorKey(member.name))
      if (current.lead !== group.lead || !isDeepStrictEqual(current.members[index], previous)) return
      this.assertMemberIdentity(group.name, member)
      if (index < 0) current.members.push({ ...member })
      else current.members[index] = { ...current.members[index], ...member }
      assertTeamGroup(current)
      atomicWriteFile(file, stringify(current))
      this.groupCache.delete(file)
      Object.assign(group, current)
      published = true
    })
    return published
  }

  restoreMembers(group: TeamGroup, members: readonly { previous: TeamMember; member: TeamMember }[]): Set<string> {
    const accepted = new Set<string>()
    if (members.length === 0) return accepted
    const dir = this.groupDir(group.name)
    this.withGroupLock(group.name, () => {
      const file = join(dir, 'group.yaml')
      if (!existsSync(file)) return
      const current = parseGroupFile(file, group.name)
      if (current.lead !== group.lead) return
      const identities = this.memberIdentityIndex()
      let changed = false
      for (const { previous, member } of members) {
        const index = current.members.findIndex((item) => item.name === previous.name)
        if (index < 0 || !isDeepStrictEqual(current.members[index], previous)) continue
        const restored = { ...current.members[index], ...member }
        try { this.assertMemberIdentity(group.name, restored, identities) }
        catch (error) {
          console.warn(`[团队] 恢复成员 ${member.name} 身份冲突: ${(error as Error).message}`)
          continue
        }
        replaceIndexedMember(identities, group.name, current.members[index], restored)
        if (!isDeepStrictEqual(current.members[index], restored)) {
          current.members[index] = restored
          changed = true
        }
        accepted.add(member.name)
      }
      if (changed) {
        assertTeamGroup(current)
        atomicWriteFile(file, stringify(current))
        this.groupCache.delete(file)
      }
      Object.assign(group, current)
    })
    return accepted
  }

  updateMemberStatus(groupName: string, memberName: string, status: TeamMember['status'], expected?: Readonly<TeamMember>): TeamMember | null {
    let member: TeamMember | null = null
    const updated = this.mutateGroup(groupName, (group) => {
      const current = group.members.find((item) => item.name === memberName)
      if (!current || (expected && !isDeepStrictEqual(current, expected))) return false
      current.status = status
      current.updatedAt = Date.now()
      member = { ...current }
    })
    if (!updated) throw new Error(`小组 ${groupName} 不存在或文件损坏`)
    return member
  }

  listGroups(options: { refresh?: boolean } = {}): string[] {
    return this.listGroupNames(options.refresh ?? false)
  }

  private listGroupNames(refresh = false): string[] {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(this.root)
    } catch (error) {
      this.groupListCache = undefined
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    }
    const cached = this.groupListCache
    if (!refresh && cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino && cached.nlink === stats.nlink) {
      return [...cached.groups]
    }
    const groups: string[] = []
    for (const entry of readdirSync(this.root)) {
      try {
        statSync(join(this.root, entry, 'group.yaml'))
        groups.push(entry)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          this.groupListCache = undefined
          throw error
        }
      }
    }
    this.groupListCache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, nlink: stats.nlink, groups }
    return [...groups]
  }

  // 任务清单（带锁）
  listTasks(groupName: string, options: { required?: boolean } = {}): TeamTask[] {
    if (!TeamGroupStore.validName(groupName)) return []
    const file = join(this.groupDir(groupName), 'tasks.json')
    let stats: Stats
    try {
      stats = statSync(file)
    } catch (error) {
      this.taskCache.delete(file)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.required) throw error
      return []
    }
    const cached = this.taskCache.get(file)
    if (cached && sameTaskSnapshot(cached, stats)) {
      return cloneTasks(cached.tasks)
    }
    try {
      const tasks = parseTaskFile(file, groupName)
      this.taskCache.set(file, taskSnapshot(stats, tasks))
      return cloneTasks(tasks)
    } catch (error) {
      this.taskCache.delete(file)
      throw error
    }
  }

  withTaskLock<T>(groupName: string, operation: (tasks: readonly TeamTask[]) => T): T {
    let result!: T
    withLock(join(this.groupDir(groupName), 'tasks.lock'), () => { result = operation(this.listTasks(groupName)) })
    return result
  }

  saveTasks(groupName: string, tasks: TeamTask[]): void {
    const dir = this.groupDir(groupName)
    const file = join(dir, 'tasks.json')
    withLock(join(dir, 'tasks.lock'), () => {
      atomicWriteFile(file, JSON.stringify(tasks, null, 2))
      this.cacheWrittenTasks(file, tasks, groupName)
    })
  }

  mutateTasks(groupName: string, mutator: (tasks: TeamTask[]) => boolean | void, options: { required?: boolean } = {}): TeamTask[] {
    const dir = this.groupDir(groupName)
    let result: TeamTask[] = []
    withLock(join(dir, 'tasks.lock'), () => {
      const file = join(dir, 'tasks.json')
      let source: TeamTask[] = []
      let stats: Stats | undefined
      try {
        stats = statSync(file)
      } catch (error) {
        this.taskCache.delete(file)
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.required) throw error
      }
      if (stats) {
        const cached = this.taskCache.get(file)
        if (cached && sameTaskSnapshot(cached, stats)) {
          source = cached.tasks
        } else {
          try {
            source = parseTaskFile(file, groupName)
            this.taskCache.set(file, taskSnapshot(stats, source))
          } catch (error) {
            this.taskCache.delete(file)
            throw error
          }
        }
      }
      const tasks = cloneTasks(source)
      const changed = mutator(tasks)
      result = tasks
      if (changed === false) return
      atomicWriteFile(file, JSON.stringify(tasks, null, 2))
      this.cacheWrittenTasks(file, tasks, groupName)
    })
    return result
  }

  updateTask(groupName: string, id: string, patch: Partial<TeamTask>): TeamTask | null {
    let updated: TeamTask | null = null
    this.mutateTasks(groupName, (tasks) => {
      const idx = tasks.findIndex((t) => t.id === id)
      if (idx < 0) return false
      tasks[idx] = { ...tasks[idx], ...patch }
      updated = tasks[idx]
      return true
    })
    return updated
  }

  claimTask(
    groupName: string,
    id: string,
    patch: Partial<TeamTask> | ((task: Readonly<TeamTask>) => Partial<TeamTask>),
    canClaim?: (task: Readonly<TeamTask>, tasks: readonly TeamTask[]) => boolean,
  ): TeamTask | null {
    let claimed: TeamTask | null = null
    this.withGroupLock(groupName, () => {
      this.mutateTasks(groupName, (tasks) => {
        const idx = tasks.findIndex((task) => task.id === id)
        if (idx < 0 || tasks[idx].status !== 'todo') return false
        if (canClaim && !canClaim(tasks[idx], tasks)) return false
        tasks[idx] = { ...tasks[idx], ...(typeof patch === 'function' ? patch(tasks[idx]) : patch) }
        claimed = tasks[idx]
        return true
      })
    })
    return claimed
  }
}
