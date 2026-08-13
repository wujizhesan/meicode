import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { TeamGroup, TeamMember, TeamTask } from './types.ts'
import { withLock } from './lock.ts'

export class TeamGroupStore {
  private root: string // <cwd>/.mewcode/team

  constructor(root: string) {
    this.root = root
  }

  groupDir(name: string): string {
    return join(this.root, name)
  }

  createGroup(name: string, lead: string): TeamGroup {
    const dir = this.groupDir(name)
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'mail'), { recursive: true })
    mkdirSync(join(dir, 'members'), { recursive: true })
    const group: TeamGroup = { name, lead, members: [] }
    writeFileSync(join(dir, 'group.yaml'), stringify(group), 'utf8')
    if (!existsSync(join(dir, 'tasks.json'))) {
      writeFileSync(join(dir, 'tasks.json'), '[]', 'utf8')
    }
    return group
  }

  loadGroup(name: string): TeamGroup | null {
    const file = join(this.groupDir(name), 'group.yaml')
    if (!existsSync(file)) return null
    try {
      return parse(readFileSync(file, 'utf8')) as TeamGroup
    } catch {
      return null
    }
  }

  saveGroup(group: TeamGroup): void {
    writeFileSync(join(this.groupDir(group.name), 'group.yaml'), stringify(group), 'utf8')
  }

  addMember(group: TeamGroup, member: TeamMember): void {
    group.members = group.members.filter((m) => m.name !== member.name)
    group.members.push(member)
    this.saveGroup(group)
  }

  listGroups(): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter((d) => existsSync(join(this.root, d, 'group.yaml')))
  }

  // 任务清单（带锁）
  listTasks(groupName: string): TeamTask[] {
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
      writeFileSync(join(this.groupDir(groupName), 'tasks.json'), JSON.stringify(tasks, null, 2), 'utf8')
    })
  }

  updateTask(groupName: string, id: string, patch: Partial<TeamTask>): TeamTask | null {
    const tasks = this.listTasks(groupName)
    const idx = tasks.findIndex((t) => t.id === id)
    if (idx < 0) return null
    tasks[idx] = { ...tasks[idx], ...patch }
    this.saveTasks(groupName, tasks)
    return tasks[idx]
  }
}
