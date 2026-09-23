import type { ContextManager } from '../context/index.ts'
import type { MemoryContext } from '../memory/index.ts'
import { newSessionId } from '../memory/index.ts'
import type { History } from '../session/history.ts'
import type { SkillManager } from '../skill/index.ts'
import { formatSessionList } from './stream-presentation.ts'

export interface SessionActions {
  clearHistory(): void
  newSession(): string
  resume(id: string): string
  listSessions(): string
  deleteSession(id: string): string
  compact(): Promise<string>
}

export interface SessionActionOptions {
  history: History
  memory?: MemoryContext
  contextManager: ContextManager
  skillManager?: SkillManager | null
  isStreaming(): boolean
  resetUi(): void
  resetRuntime?(): void
  onSessionChange?(sessionId: string): void
}

export function createSessionActions(options: SessionActionOptions): SessionActions {
  const { history, memory, contextManager, skillManager, isStreaming, resetUi, resetRuntime, onSessionChange } = options
  const reset = (): void => {
    history.clear()
    resetUi()
    resetRuntime?.()
    skillManager?.clear()
  }
  const switchSession = (sessionId: string): string | null => {
    try {
      onSessionChange?.(sessionId)
      if (memory) memory.sessionId = sessionId
      return null
    } catch (error) {
      return `切换会话失败: ${(error as Error).message}`
    }
  }

  return {
    clearHistory() {
      if (isStreaming()) return
      reset()
    },
    newSession() {
      if (isStreaming()) return '执行中，无法新建会话'
      const sessionId = newSessionId()
      const failure = switchSession(sessionId)
      if (failure) return failure
      reset()
      return '已新建会话'
    },
    resume(id) {
      if (isStreaming()) return '执行中，无法切换会话'
      const recovered = memory?.sessionStore?.recoverById(id)
      if (!recovered) return `未找到会话: ${id}`
      const failure = switchSession(id)
      if (failure) return failure
      reset()
      for (const message of recovered.messages) history.push(message)
      return `已恢复会话 ${id}（${recovered.messages.length} 条消息）`
    },
    listSessions() {
      return formatSessionList(memory?.sessionStore?.listSessions(10) ?? [])
    },
    deleteSession(id) {
      if (memory?.sessionId === id) return '不能删除当前会话'
      return memory?.sessionStore?.removeById(id) ? `已删除会话 ${id}` : `未找到会话: ${id}`
    },
    async compact() {
      if (isStreaming()) return '压缩进行中，请稍候'
      try {
        await contextManager.beforeRequest('manual')
        return contextManager.lastSummary ? '压缩完成：早期对话已摘要' : '无需压缩（未达窗口上限）'
      } catch (error) {
        return `压缩失败: ${(error as Error).message}`
      }
    },
  }
}
