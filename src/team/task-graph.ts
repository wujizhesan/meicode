import type { TeamTask } from './types.ts'

export function validateTaskDependencies(tasks: TeamTask[], taskId: string, dependencies: string[]): string | null {
  const graph = new Map(tasks.map((task) => [task.id, task.depends_on ?? []]))
  graph.set(taskId, dependencies)

  for (const dependency of dependencies) {
    if (!graph.has(dependency)) return `依赖任务不存在: ${dependency}`
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): string | null => {
    if (visiting.has(id)) return `任务依赖形成循环: ${id}`
    if (visited.has(id)) return null
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) {
      const error = visit(dependency)
      if (error) return error
    }
    visiting.delete(id)
    visited.add(id)
    return null
  }

  for (const id of graph.keys()) {
    const error = visit(id)
    if (error) return error
  }
  return null
}

export function taskBlockers(tasks: TeamTask[], task: TeamTask): string[] {
  const tasksById = new Map(tasks.map((item) => [item.id, item]))
  return (task.depends_on ?? []).filter((dependency) => tasksById.get(dependency)?.status !== 'done')
}

export function readyTasks(tasks: TeamTask[], now = Date.now()): TeamTask[] {
  return tasks.filter(
    (task) => task.status === 'todo'
      && (task.nextRetryAt ?? 0) <= now
      && taskBlockers(tasks, task).length === 0,
  )
}

export function recoverExpiredTasks(tasks: TeamTask[], now = Date.now()): TeamTask[] {
  const recovered: TeamTask[] = []
  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.leaseExpiresAt || task.leaseExpiresAt > now) continue
    const retryable = (task.attempt ?? 0) < (task.maxAttempts ?? 1)
    task.status = retryable ? 'todo' : 'failed'
    task.updatedAt = now
    task.lastError = '任务租约过期，执行进程可能已退出'
    task.nextRetryAt = retryable ? now : undefined
    task.activeAgentId = undefined
    task.leaseId = undefined
    task.leaseExpiresAt = undefined
    recovered.push({ ...task })
  }
  return recovered
}
