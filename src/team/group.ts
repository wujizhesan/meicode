import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { TeamGroup, TeamMember, TeamTask } from './types.ts'
import { withLock } from './lock.ts'
import { atomicWriteFile } from './atomic.ts'

export class TeamGroupStore {
  private root: string // <cwd>/.mewcode/team

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
    return group
  }

  loadGroup(name: string): TeamGroup | null {
    if (!TeamGroupStore.validName(name)) return null
    const file = join(this.groupDir(name), 'group.yaml')
    if (!existsSync(file)) return null
    try {
      return parse(readFileSync(file, 'utf8')) as TeamGroup
    } catch {
      return null
    }
  }

  saveGroup(group: TeamGroup): void {
    const dir = this.groupDir(group.name)
    withLock(join(dir, 'group.lock'), () => atomicWriteFile(join(dir, 'group.yaml'), stringify(group)))
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
      updated = group
    })
    return updated
  }

  addMember(group: TeamGroup, member: TeamMember): void {
    const updated = this.mutateGroup(group.name, (current) => {
      current.members = current.members.filter((m) => m.name !== member.name)
      current.members.push(member)
    })
    if (updated) Object.assign(group, updated)
  }

  listGroups(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter((d) => existsSync(join(this.root, d, 'group.yaml')))
  }

  // 任务清单（带锁）
  listTasks(groupName: string): TeamTask[] {
    if (!TeamGroupStore.validName(groupName)) return []
    const file = join(this.groupDir(groupName), 'tasks.json')
    if (!existsSync(file)) return []
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as TeamTask[]
    } catch {
      return []
    }
  }

  saveTasks(groupName: string, tasks: TeamTask[]): void {
    withLock(join(this.groupDir(groupName), 'tasks.lock'), () => {
      atomicWriteFile(join(this.groupDir(groupName), 'tasks.json'), JSON.stringify(tasks, null, 2))
    })
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
