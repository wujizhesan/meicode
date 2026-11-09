import type { ContextManager } from '../context/index.ts'
import type { MemoryContext, SessionPersistenceCursor } from '../memory/index.ts'
import { createSessionPersistenceCursor, newSessionId, persistSessionHistoryWithConflictCopy } from '../memory/index.ts'
import type { History } from '../session/history.ts'
import type { SkillManager } from '../skill/index.ts'
import type { HookEngine } from '../hook/engine.ts'
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
  hooks?: Pick<HookEngine, 'clearSession' | 'clearAgent'> | null
  agentId?: string
  isStreaming(): boolean
  resetUi(): void
  resetRuntime?(): void
  onSessionChange?(sessionId: string): void
  onResume?(): void
  persistHistory?(): boolean
  persistBeforeSwitch?(): boolean
  beforeCompact?(): void
}

export function createSessionActions(options: SessionActionOptions): SessionActions {
  const { history, memory, contextManager, skillManager, isStreaming, resetUi, resetRuntime, onSessionChange } = options
  const reset = (): void => {
    history.clear()
    contextManager.reset()
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
  const persist = (savedCursor?: SessionPersistenceCursor): boolean => {
    if (options.persistHistory) return options.persistHistory()
    if (!memory?.sessionStore || !memory.sessionId) return true
    try {
      const cursor = savedCursor ?? createSessionPersistenceCursor(history)
      cursor.structureVersion = -1
      const result = persistSessionHistoryWithConflictCopy(memory.sessionStore, memory.sessionId, history, cursor)
      if (result.conflictCopyId) {
        const failure = switchSession(result.conflictCopyId)
        if (failure) throw new Error(failure)
        memory.sessionStore.recoverById(result.conflictCopyId)
      }
      return true
    } catch (error) {
      console.warn(`会话保存失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  const persistBeforeSwitch = (): boolean => options.persistBeforeSwitch?.() ?? persist()
  const preservedCopyMessage = (previousSessionId: string | undefined): string => memory?.sessionId && memory.sessionId !== previousSessionId
    ? `；切换前内容已保存为冲突副本 ${memory.sessionId}` : ''

  return {
    clearHistory() {
      if (isStreaming()) return
      if (memory?.sessionId) options.hooks?.clearSession(memory.sessionId)
      if (options.agentId) options.hooks?.clearAgent(memory?.sessionId, options.agentId)
      reset()
      persist()
    },
    newSession() {
      if (isStreaming()) return '执行中，无法新建会话'
      const previousSessionId = memory?.sessionId
      if (!persistBeforeSwitch()) return '当前会话保存失败，已保留当前会话，请修复存档问题后重试'
      const preserved = preservedCopyMessage(previousSessionId)
      const sessionId = newSessionId()
      const failure = switchSession(sessionId)
      if (failure) return failure
      reset()
      return `已新建会话${preserved}`
    },
    resume(id) {
      if (isStreaming()) return '执行中，无法切换会话'
      let recovered = memory?.sessionStore?.prepareRecovery(id)
      if (!recovered) return `未找到会话: ${id}`
      const previousSessionId = memory?.sessionId
      if (!persistBeforeSwitch()) return '当前会话保存失败，已保留当前会话，请修复存档问题后重试'
      const preserved = preservedCopyMessage(previousSessionId)
      if (id === previousSessionId) {
        recovered = memory?.sessionStore?.prepareRecovery(id)
        if (!recovered) return `未找到会话: ${id}`
      }
      const failure = switchSession(id)
      if (failure) return failure
      reset()
      for (const message of recovered.messages) history.push(message)
      recovered.commit()
      options.onResume?.()
      return `已恢复会话 ${id}（${recovered.messages.length} 条消息）${preserved}`
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
        const cursor = createSessionPersistenceCursor(history)
        options.beforeCompact?.()
        const result = await contextManager.compact()
        if (result.status === 'compacted') {
          return persist(cursor) ? '压缩完成：早期对话已摘要' : '压缩已完成，但会话保存失败；下次发送将重试保存'
        }
        if (result.status === 'failed') return `压缩失败: ${result.error}`
        if (result.status === 'stale') return '压缩已取消：会话或历史已变化，请重试'
        if (result.status === 'cancelled') return '压缩已取消，请重试'
        if (result.reason === 'insufficient_history') return '无需压缩（没有可摘要的早期消息）'
        if (result.reason === 'breaker_open') return '压缩已暂停，请重试'
        return '无需压缩（未达窗口上限）'
      } catch (error) {
        return `压缩失败: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}
