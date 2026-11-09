import type { ChatMessage } from '../provider/types.ts'

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = message.content.length + (message.tool_call_id?.length ?? 0)
  for (const call of message.tool_calls ?? []) {
    chars += call.id.length + call.name.length + call.arguments.length
  }
  return Math.ceil(chars / 4)
}

// 近似估算：锚定上次 API usage，增量按 字符数/4 估算（无精确 tokenizer）
export class TokenEstimator {
  private anchorTokens = 0
  private anchorCount = 0
  private anchorOverheadTokens = 0
  private hasAnchor = false

  estimate(messages: readonly ChatMessage[], overheadTokens = 0): number {
    if (!this.hasAnchor) {
      return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overheadTokens
    }
    let delta = 0
    for (let i = this.anchorCount; i < messages.length; i++) {
      delta += estimateMessageTokens(messages[i])
    }
    return Math.max(0, this.anchorTokens + delta + overheadTokens - this.anchorOverheadTokens)
  }

  update(usageInputTokens: number, messageCount: number, overheadTokens = 0): void {
    this.anchorTokens = usageInputTokens
    this.anchorCount = messageCount
    this.anchorOverheadTokens = overheadTokens
    this.hasAnchor = true
  }
}
