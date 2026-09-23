import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { TeamGroup, TeamMember, TeamTask, TeamTaskReport } from './types.ts'
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

interface CachedTeamTasks {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  tasks: TeamTask[]
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
  let value: unknown
  try {
    value = parse(readFileSync(file, 'utf8'))
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
  return true
}

function parseTaskFile(file: string): TeamTask[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(value)) throw new Error('根节点不是数组')
    const invalidIndex = value.findIndex((task) => !isTeamTask(task))
    if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 1} 项不是合法任务`)
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

  constructor(root: string) {
    this.root = root
  }

  groupDir(name: string): string {
    if (!TeamGroupStore.validName(name)) throw new Error(`非法团队名称: ${name}`)
    return join(this.root, name)
  }

  static validName(name: string): boolean {
    return Boolean(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
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
    withLock(join(dir, 'group.lock'), () => {
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

  loadGroup(name: string): TeamGroup | null {
    if (!TeamGroupStore.validName(name)) return null
    const file = join(this.groupDir(name), 'group.yaml')
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(file)
    } catch {
      this.groupCache.delete(file)
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
    } catch {
      this.groupCache.delete(file)
      return null
    }
  }

  saveGroup(group: TeamGroup): void {
    assertTeamGroup(group)
    const dir = this.groupDir(group.name)
    const file = join(dir, 'group.yaml')
    withLock(join(dir, 'group.lock'), () => atomicWriteFile(file, stringify(group)))
    this.groupCache.delete(file)
  }

  mutateGroup(name: string, mutator: (group: TeamGroup) => void): TeamGroup | null {
    const dir = this.groupDir(name)
    let updated: TeamGroup | null = null
    withLock(join(dir, 'group.lock'), () => {
      const file = join(dir, 'group.yaml')
      if (!existsSync(file)) return
      let group: TeamGroup
      try {
        group = parseGroupFile(file, name)
      } catch {
        return
      }
      mutator(group)
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

  updateMemberStatus(groupName: string, memberName: string, status: TeamMember['status']): TeamMember | null {
    let member: TeamMember | null = null
    const updated = this.mutateGroup(groupName, (group) => {
      const current = group.members.find((item) => item.name === memberName)
      if (!current) return
      current.status = status
      current.updatedAt = Date.now()
      member = { ...current }
    })
    if (!updated) throw new Error(`小组 ${groupName} 不存在或文件损坏`)
    return member
  }

  listGroups(): string[] {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(this.root)
    } catch {
      this.groupListCache = undefined
      return []
    }
    const cached = this.groupListCache
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino && cached.nlink === stats.nlink) {
      return [...cached.groups]
    }
    const groups: string[] = []
    for (const entry of readdirSync(this.root)) {
      try {
        statSync(join(this.root, entry, 'group.yaml'))
        groups.push(entry)
      } catch {
      }
    }
    this.groupListCache = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, nlink: stats.nlink, groups }
    return [...groups]
  }

  // 任务清单（带锁）
  listTasks(groupName: string): TeamTask[] {
    if (!TeamGroupStore.validName(groupName)) return []
    const file = join(this.groupDir(groupName), 'tasks.json')
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(file)
    } catch {
      this.taskCache.delete(file)
      return []
    }
    const cached = this.taskCache.get(file)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
      return cloneTasks(cached.tasks)
    }
    try {
      const tasks = parseTaskFile(file)
      this.taskCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, tasks })
      return cloneTasks(tasks)
    } catch (error) {
      this.taskCache.delete(file)
      throw error
    }
  }

  saveTasks(groupName: string, tasks: TeamTask[]): void {
    const dir = this.groupDir(groupName)
    const file = join(dir, 'tasks.json')
    withLock(join(dir, 'tasks.lock'), () => {
      atomicWriteFile(file, JSON.stringify(tasks, null, 2))
    })
    this.taskCache.delete(file)
  }

  mutateTasks(groupName: string, mutator: (tasks: TeamTask[]) => void): TeamTask[] {
    const dir = this.groupDir(groupName)
    let result: TeamTask[] = []
    withLock(join(dir, 'tasks.lock'), () => {
      const file = join(dir, 'tasks.json')
      let tasks: TeamTask[] = []
      if (existsSync(file)) tasks = parseTaskFile(file)
      mutator(tasks)
      atomicWriteFile(file, JSON.stringify(tasks, null, 2))
      this.taskCache.delete(file)
      result = tasks
    })
    return result
  }

  updateTask(groupName: string, id: string, patch: Partial<TeamTask>): TeamTask | null {
    let updated: TeamTask | null = null
    this.mutateTasks(groupName, (tasks) => {
      const idx = tasks.findIndex((t) => t.id === id)
      if (idx >= 0) {
        tasks[idx] = { ...tasks[idx], ...patch }
        updated = tasks[idx]
      }
    })
    return updated
  }

  claimTask(groupName: string, id: string, patch: Partial<TeamTask>): TeamTask | null {
    let claimed: TeamTask | null = null
    this.mutateTasks(groupName, (tasks) => {
      const idx = tasks.findIndex((task) => task.id === id)
      if (idx < 0 || tasks[idx].status !== 'todo') return
      tasks[idx] = { ...tasks[idx], ...patch }
      claimed = tasks[idx]
    })
    return claimed
  }
}
