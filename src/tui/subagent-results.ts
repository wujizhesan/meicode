import type { History } from '../session/history.ts'
import type { SubAgentRecord } from '../subagent/types.ts'
import type { SessionStore } from '../memory/session.ts'

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'timed_out'])

export class SubAgentResults {
  private pending: string[] = []
  private seen = new Map<string, Set<string>>()

  receive(record: SubAgentRecord, sessionId: string | undefined, history: History, store?: SessionStore): string | null {
    if (!TERMINAL_STATUSES.has(record.status)) return null
    if (record.sessionId && record.sessionId !== sessionId
      && (!sessionId || !store?.getSubAgentTaskSources(sessionId).some((source) => source.sessionId === record.sessionId && source.agentId === record.id))) return null
    const id = record.reportId || record.id
    const session = sessionId ?? ''
    const seen = this.seen.get(session) ?? new Set<string>()
    if (seen.has(id)) return null
    const marker = `[子任务报告 ${id}]\n`
    const recorded = history.view().some((message) => message.role === 'system' && message.content.startsWith(marker))
      || (sessionId && store?.hasReportReceipt(sessionId, id))
    seen.add(id)
    this.seen.set(session, seen)
    if (recorded) return null
    const status = record.status === 'done' ? '已完成'
      : record.status === 'cancelled' ? '已取消'
        : record.status === 'timed_out' ? '已超时' : '已失败'
    const detail = record.status === 'done'
      ? record.result || '子任务未产生输出'
      : `${record.error || status}${record.result && record.result !== record.error ? `\n部分结果：${record.result}` : ''}`
    const text = `[子任务 ${record.role}] ${status}：${detail}`
    this.pending.push(`${marker}${text}`)
    return `${record.status === 'done' ? '📦' : '⚠️'} ${text}`
  }

  take(): string[] {
    return this.pending.splice(0)
  }

  restore(messages: string[]): void {
    this.pending.unshift(...messages)
  }

  clearPending(): void {
    this.pending.length = 0
  }

  resetForRecovery(sessionId: string | undefined): void {
    this.seen.delete(sessionId ?? '')
  }
}
