import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { TeamGroup, TeamMember, TeamTask } from './types.ts'
import { withLock } from './lock.ts'
import { atomicWriteFile } from './atomic.ts'

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

export class TeamGroupStore {
  private root: string // <cwd>/.mewcode/team
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

  private static validName(name: string): boolean {
    return Boolean(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
  }

  createGroup(name: string, lead: string): TeamGroup {
    const dir = this.groupDir(name)
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'mail'), { recursive: true })
    mkdirSync(join(dir, 'members'), { recursive: true })
    const group: TeamGroup = { name, lead, members: [] }
    atomicWriteFile(join(dir, 'group.yaml'), stringify(group))
    if (!existsSync(join(dir, 'tasks.json'))) {
      atomicWriteFile(join(dir, 'tasks.json'), '[]')
    }
    this.groupListCache = undefined
    return group
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
      const group = parse(readFileSync(file, 'utf8')) as TeamGroup
      this.groupCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, group })
      return cloneGroup(group)
    } catch {
      this.groupCache.delete(file)
      return null
    }
  }

  saveGroup(group: TeamGroup): void {
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
        group = parse(readFileSync(file, 'utf8')) as TeamGroup
      } catch {
        return
      }
      mutator(group)
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
    const names = new Set(members.map((member) => member.name))
    const updated = this.mutateGroup(group.name, (current) => {
      current.members = current.members.filter((member) => !names.has(member.name))
      current.members.push(...members.map((member) => ({ ...member })))
    })
    if (updated) Object.assign(group, updated)
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
      const tasks = JSON.parse(readFileSync(file, 'utf8')) as TeamTask[]
      this.taskCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, tasks })
      return cloneTasks(tasks)
    } catch {
      this.taskCache.delete(file)
      return []
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
      if (existsSync(file)) {
        try {
          tasks = JSON.parse(readFileSync(file, 'utf8')) as TeamTask[]
        } catch {
        }
      }
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
