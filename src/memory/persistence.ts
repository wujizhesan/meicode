import type { History } from '../session/history.ts'
import { SessionConflictError, type SessionStore, subAgentReportId } from './session.ts'
import type { SubAgentTaskSource } from './session.ts'

export interface SessionPersistenceCursor {
  length: number
  structureVersion: number
  reportIds: Set<string>
}

export function createSessionPersistenceCursor(history: History): SessionPersistenceCursor {
  const cursor = { length: history.length, structureVersion: history.structureVersion, reportIds: new Set<string>() }
  captureSessionReportReceipts(history, cursor)
  return cursor
}

export function captureSessionReportReceipts(history: History, cursor: SessionPersistenceCursor): void {
  for (const message of history.view()) {
    const id = subAgentReportId(message)
    if (id) cursor.reportIds.add(id)
  }
}

export function persistSessionHistory(
  store: SessionStore,
  sessionId: string,
  history: History,
  cursor: SessionPersistenceCursor,
): void {
  const messages = history.view()
  captureSessionReportReceipts(history, cursor)
  if (history.structureVersion !== cursor.structureVersion || messages.length < cursor.length) {
    store.replace(sessionId, [...messages], [...cursor.reportIds])
  } else if (cursor.length < messages.length) {
    store.append(sessionId, [...messages].slice(cursor.length), [...cursor.reportIds])
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
  getConflictTaskSources?: () => readonly SubAgentTaskSource[],
): { conflictCopyId?: string } {
  try {
    persistSessionHistory(store, sessionId, history, cursor)
    return {}
  } catch (error) {
    if (!(error instanceof SessionConflictError)) throw error
    try {
      return { conflictCopyId: store.saveConflictCopy(sessionId, [...history.view()], [...cursor.reportIds], getConflictTaskSources?.() ?? []) }
    } catch (copyError) {
      throw new Error(`会话保存冲突，且冲突副本创建失败：${(copyError as Error).message}`, { cause: error })
    }
  }
}
