import type { History } from '../session/history.ts'
import { SessionConflictError, SessionStore } from './session.ts'

export interface SessionPersistenceCursor {
  length: number
  structureVersion: number
}

export function createSessionPersistenceCursor(history: History): SessionPersistenceCursor {
  return { length: history.length, structureVersion: history.structureVersion }
}

export function persistSessionHistory(
  store: SessionStore,
  sessionId: string,
  history: History,
  cursor: SessionPersistenceCursor,
): void {
  const messages = history.view()
  if (history.structureVersion !== cursor.structureVersion || messages.length < cursor.length) {
    store.replace(sessionId, [...messages])
  } else if (cursor.length < messages.length) {
    store.append(sessionId, [...messages].slice(cursor.length))
  }
  cursor.length = messages.length
  cursor.structureVersion = history.structureVersion
}

export function tryPersistSessionHistory(
  store: SessionStore,
  sessionId: string,
  history: History,
  cursor: SessionPersistenceCursor,
): 'persisted' | 'conflict' {
  try {
    persistSessionHistory(store, sessionId, history, cursor)
    return 'persisted'
  } catch (error) {
    if (error instanceof SessionConflictError) return 'conflict'
    throw error
  }
}

export function persistSessionHistoryWithConflictCopy(
  store: SessionStore,
  sessionId: string,
  history: History,
  cursor: SessionPersistenceCursor,
): { conflictCopyId?: string } {
  try {
    persistSessionHistory(store, sessionId, history, cursor)
    return {}
  } catch (error) {
    if (!(error instanceof SessionConflictError)) throw error
    try {
      return { conflictCopyId: store.saveConflictCopy(sessionId, [...history.view()]) }
    } catch (copyError) {
      throw new Error(`会话保存冲突，且冲突副本创建失败：${(copyError as Error).message}`, { cause: error })
    }
  }
}
