import type { TeamTask } from './types.ts'

const TEAM_ACTOR_RE = /^[A-Za-z0-9_-]{1,64}$/
const TASK_TITLE_MAX_CHARS = 4000
export const TASK_MAX_ATTEMPTS = 100

export function isTeamActorName(name: string): boolean {
  return TEAM_ACTOR_RE.test(name)
}

export function teamActorKey(name: string): string {
  return name.toLowerCase()
}

export function assertTeamActorName(name: string, label = '成员名'): void {
  if (!isTeamActorName(name)) throw new Error(`${label}只能包含字母、数字、下划线和连字符，长度为 1-64`)
}

export function parseTaskTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('任务标题必须是字符串')
  const title = value.trim()
  if (!title) throw new Error('任务标题不能为空')
  if (title.length > TASK_TITLE_MAX_CHARS) throw new Error(`任务标题不能超过 ${TASK_TITLE_MAX_CHARS} 个字符`)
  return title
}

export function parseTaskDependencies(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('任务依赖必须是任务 ID 数组')
  for (const id of value) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('依赖任务 ID 必须是非空字符串')
  }
  return [...value]
}

export function parseTaskMaxAttempts(value: unknown): number {
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TASK_MAX_ATTEMPTS) {
    throw new Error(`最多执行次数必须是 1-${TASK_MAX_ATTEMPTS} 之间的整数`)
  }
  return value
}

export function parseTaskUpdate(patch: { status?: unknown; result?: unknown }): { status?: TeamTask['status']; result?: string } {
  if (patch.status === undefined && patch.result === undefined) throw new Error('任务更新至少需要 status 或 result')
  const update: { status?: TeamTask['status']; result?: string } = {}
  if (patch.status !== undefined) {
    if (patch.status !== 'todo' && patch.status !== 'in_progress' && patch.status !== 'done' && patch.status !== 'failed') {
      throw new Error(`非法任务状态: ${String(patch.status)}`)
    }
    update.status = patch.status
  }
  if (patch.result !== undefined) {
    if (typeof patch.result !== 'string') throw new Error('任务结果必须是字符串')
    update.result = patch.result
  }
  return update
}
