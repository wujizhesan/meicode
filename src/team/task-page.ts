import type { TeamTask } from './types.ts'

const TASK_PAGE_DEFAULT = 50
const TASK_PAGE_MAX = 100
const TASK_STATUSES = new Set<TeamTask['status']>(['todo', 'in_progress', 'done', 'failed', 'cancelled'])

export interface TaskPage {
  tasks: TeamTask[]
  total: number
  matched: number
  nextCursor?: string
}

export function paginateTasks(tasks: readonly TeamTask[], args: { limit?: unknown; cursor?: unknown; status?: unknown }): TaskPage {
  const limit = args.limit ?? TASK_PAGE_DEFAULT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > TASK_PAGE_MAX) {
    throw new Error(`任务每页数量必须在 1-${TASK_PAGE_MAX} 之间`)
  }
  const status = args.status
  if (status !== undefined && status !== 'all' && !TASK_STATUSES.has(status as TeamTask['status'])) {
    throw new Error('非法任务状态筛选条件')
  }
  const cursor = args.cursor
  let end = tasks.length
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !cursor.startsWith('id:') || cursor.length === 3) throw new Error('任务分页游标无效')
    end = tasks.findIndex((task) => task.id === cursor.slice(3))
    if (end < 0) throw new Error('任务分页游标无效或已过期')
  }
  const matches = (task: TeamTask): boolean => status === undefined || status === 'all' || task.status === status
  let matched = 0
  for (const task of tasks) if (matches(task)) matched++
  const page: TeamTask[] = []
  let lastIndex = -1
  let nextCursor: string | undefined
  for (let index = end - 1; index >= 0; index--) {
    const task = tasks[index]
    if (!matches(task)) continue
    if (page.length === limit) {
      nextCursor = `id:${tasks[lastIndex].id}`
      break
    }
    page.push(task)
    lastIndex = index
  }
  return { tasks: page, total: tasks.length, matched, nextCursor }
}

function preview(value: string, maxLength: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line
}

export function taskSummary(task: TeamTask): {
  id: string
  title: string
  status: TeamTask['status']
  assignee?: string
  dependsOnCount: number
  resultPreview?: string
} {
  return {
    id: task.id,
    title: preview(task.title, 160),
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    dependsOnCount: task.depends_on?.length ?? 0,
    ...(task.result ? { resultPreview: preview(task.result, 160) } : {}),
  }
}
