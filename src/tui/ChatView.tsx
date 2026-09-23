import { Box, Text } from 'ink'
import { memo, useRef, type ReactElement } from 'react'
import type { Mode, UIMessage } from './types.ts'

const STREAMING_HISTORY_LIMIT = 200
const STREAMING_HISTORY_CHAR_LIMIT = 50_000

const ChatMessageRow = memo(function ChatMessageRow({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.role === 'user' ? (
        <Text color="cyan">❯ {message.text}</Text>
      ) : message.role === 'tool' ? (
        <Text dimColor>  {message.text}</Text>
      ) : (
        <>
          {message.thinking ? (
            <Text dimColor>
              🧠 {message.thinking}
              {streaming ? '▍' : ''}
            </Text>
          ) : null}
          <Text>{message.text || (streaming ? '…' : '')}</Text>
        </>
      )}
    </Box>
  )
})

export function ChatView({ messages, mode, compact = false }: { messages: UIMessage[]; mode: Mode; compact?: boolean }) {
  const rowCache = useRef<{ messages: UIMessage[]; streamingIndex: number; rows: ReactElement[] }>({ messages: [], streamingIndex: -1, rows: [] })
  if (messages.length === 0) {
    rowCache.current = { messages, streamingIndex: -1, rows: [] }
    return (
      <Box flexDirection="column">
        <Text dimColor>MeiCode 就绪——输入问题开始对话</Text>
        <Text dimColor>命令：/mode default|edits|plan|yolo 切换模式（/plan 等价 /mode plan）</Text>
      </Box>
    )
  }
  let streamingIndex = -1
  if (mode === 'streaming') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        streamingIndex = i
        break
      }
    }
  }
  const previous = rowCache.current
  let reusable = 0
  const limit = Math.min(previous.messages.length, messages.length)
  while (
    reusable < limit
    && previous.messages[reusable] === messages[reusable]
    && (reusable === previous.streamingIndex) === (reusable === streamingIndex)
  ) {
    reusable++
  }
  const rows = previous.rows.slice(0, reusable)
  for (let i = reusable; i < messages.length; i++) {
    rows.push(<ChatMessageRow key={i} message={messages[i]} streaming={i === streamingIndex} />)
  }
  rowCache.current = { messages, streamingIndex, rows }
  let firstVisible = 0
  if (mode === 'streaming' || compact) {
    firstVisible = Math.max(0, rows.length - STREAMING_HISTORY_LIMIT)
    let visibleChars = 0
    for (let i = rows.length - 1; i >= firstVisible; i--) {
      const messageChars = messages[i].text.length + (messages[i].thinking?.length ?? 0)
      if (i < rows.length - 1 && visibleChars + messageChars > STREAMING_HISTORY_CHAR_LIMIT) {
        firstVisible = i + 1
        break
      }
      visibleChars += messageChars
    }
  }
  return (
    <Box flexDirection="column">
      {firstVisible > 0 ? <Text dimColor>… {mode === 'streaming' ? '输出' : '输入'}期间暂时折叠前 {firstVisible} 条消息</Text> : null}
      {firstVisible > 0 ? rows.slice(firstVisible) : rows}
    </Box>
  )
}
