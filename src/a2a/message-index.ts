import type { A2AMessage, A2ATask } from './types.ts'

export class A2aMessageIndex {
  private readonly taskIds = new Map<string, string | Set<string>>()

  addTask(task: A2ATask): void {
    this.addTaskIds(task.id, task.history.map((message) => message.messageId))
  }

  addTaskIds(taskId: string, messageIds: string[]): void {
    for (const messageId of messageIds) this.addMessage(taskId, { messageId })
  }

  addMessage(taskId: string, message: Pick<A2AMessage, 'messageId'>): void {
    const taskIds = this.taskIds.get(message.messageId)
    if (taskIds === undefined) {
      this.taskIds.set(message.messageId, taskId)
    } else if (typeof taskIds === 'string') {
      if (taskIds !== taskId) this.taskIds.set(message.messageId, new Set([taskIds, taskId]))
    } else {
      taskIds.add(taskId)
    }
  }

  taskIdFor(messageId: string): string | undefined {
    const taskIds = this.taskIds.get(messageId)
    return typeof taskIds === 'string' ? taskIds : taskIds?.values().next().value
  }

  removeTask(task: A2ATask): void {
    this.removeTaskIds(task.id, task.history.map((message) => message.messageId))
  }

  removeTaskIds(taskId: string, messageIds: string[]): void {
    for (const messageId of messageIds) {
      const taskIds = this.taskIds.get(messageId)
      if (typeof taskIds === 'string') {
        if (taskIds === taskId) this.taskIds.delete(messageId)
        continue
      }
      if (!taskIds) continue
      taskIds.delete(taskId)
      if (taskIds.size === 0) this.taskIds.delete(messageId)
      else if (taskIds.size === 1) this.taskIds.set(messageId, taskIds.values().next().value!)
    }
  }
}
