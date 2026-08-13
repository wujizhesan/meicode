import type { ChatMessage } from '../provider/types.ts'

// 近似估算：锚定上次 API usage，增量按 字符数/4 估算（无精确 tokenizer）
export class TokenEstimator {
  private anchorTokens = 0
  private anchorCount = 0
  private hasAnchor = false

  estimate(messages: ChatMessage[]): number {
    if (!this.hasAnchor) {
      return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
    }
    const delta = messages
      .slice(this.anchorCount)
      .reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
    return this.anchorTokens + delta
  }

  update(usageInputTokens: number, messageCount: number): void {
    this.anchorTokens = usageInputTokens
    this.anchorCount = messageCount
    this.hasAnchor = true
  }
}
