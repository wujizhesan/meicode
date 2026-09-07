import type { Provider, ChatMessage } from '../provider/types.ts'
import type { ToolContext } from '../tools/index.ts'

export const SUMMARY_SYSTEM = `你是 MeiCode 的上下文压缩器。你的任务是把一段对话历史压缩成结构化摘要。

硬性要求：
- 禁止调用任何工具
- 先写分析草稿（仅供内部思考，不要输出），再输出正式摘要
- 不要推测未发生的事，只概括已发生的内容

摘要按以下五部分组织：
1. 任务目标：用户整体想要达成什么
2. 已完成事项：已经完成的操作与结果
3. 进行中事项：尚未完成、需要继续的工作
4. 关键决策：过程中做出的重要决定
5. 文件与代码状态：被创建/修改/读取的文件及关键内容

输出格式：直接输出五部分正文，不要额外说明。`

export const BOUNDARY_MESSAGE =
  '部分早期对话已摘要。如需文件/代码细节，请重新调用工具读取，不要凭摘要推测内容。'

// 从尾部往回保留 keepTokens（字符/4 估算）且至少 minCount 条
export function tailKeep(
  messages: readonly ChatMessage[],
  keepTokens = 10000,
  minCount = 5,
): { keep: ChatMessage[]; drop: ChatMessage[] } {
  let tokens = 0
  let count = 0
  let start = messages.length
  while (start > 0) {
    start--
    tokens += Math.ceil(messages[start].content.length / 4)
    count++
    if (tokens >= keepTokens && count >= minCount) break
  }
  return { keep: messages.slice(start), drop: messages.slice(0, start) }
}

// 独立调用 LLM 生成摘要（不进 history，无 tools）
export async function summarize(
  provider: Provider,
  earlyMessages: ChatMessage[],
  ctx: ToolContext,
): Promise<string> {
  const msgs: ChatMessage[] = [{ role: 'system', content: SUMMARY_SYSTEM }, ...earlyMessages]
  const textParts: string[] = []
  for await (const ev of provider.streamChat(msgs, { thinking: false })) {
    if (ev.type === 'text') textParts.push(ev.text)
    else if (ev.type === 'error') throw new Error(`摘要请求失败: ${ev.message}`)
  }
  const text = textParts.join('')
  if (!text.trim()) throw new Error('摘要返回为空')
  return text.trim()
}

export function summaryMessage(summary: string): ChatMessage {
  const date = new Date().toISOString().slice(0, 10)
  return { role: 'system', content: `以下为早期对话摘要（${date}）：\n${summary}` }
}

export function boundaryMessage(): ChatMessage {
  return { role: 'system', content: BOUNDARY_MESSAGE }
}
