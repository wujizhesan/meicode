import type { StopReason } from '../agent/events.ts'
import type { UIMessage } from './types.ts'

export interface SessionListItem {
  id: string
  count: number
  mtime: number
}

export interface RoundTool {
  id: string
  name: string
  status: 'running' | 'ok' | 'fail'
}

export function appendStreamChunk(messages: UIMessage[], text: string, thinking: string): UIMessage[] {
  const index = messages.length - 1
  const current = messages[index]
  if (!current || current.role !== 'assistant' || (!text && !thinking)) return messages
  const next = messages.slice()
  next[index] = {
    ...current,
    text: current.text + text,
    thinking: (current.thinking ?? '') + thinking,
  }
  return next
}

export function formatSessionList(items: SessionListItem[]): string {
  if (items.length === 0) return '暂无会话记录'
  const lines = items.map((item) => {
    let date = ''
    if (item.mtime > 0) {
      const value = new Date(item.mtime)
      date = `，${value.getMonth() + 1}/${value.getDate()} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
    }
    return `  ${item.id}（${item.count} 条${date}）`
  })
  return `会话列表（最近 ${items.length} 个，/session del <id> 删除）:\n${lines.join('\n')}`
}

export function formatRoundTools(items: RoundTool[]): string {
  const parts = items.map((item) =>
    `${item.name}${item.status === 'running' ? '…' : item.status === 'ok' ? ' ✓' : ' ✗'}`)
  return `🔧 [${items.length}] ${parts.join(' · ')}`
}

export function stopReasonError(reason: StopReason, rounds: number, errorMessage?: string): string | null {
  if (reason === 'max_iterations') return `达到迭代上限（${rounds} 轮）`
  if (reason === 'unknown_tool') return '连续调用未知工具，已停止'
  if (reason === 'cancelled') return '已取消'
  if (reason === 'tool_failures') return errorMessage ?? '工具连续失败，已停止'
  if (reason === 'error') return errorMessage ?? '流错误，已停止'
  return null
}
