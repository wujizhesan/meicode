import { Box, Text } from 'ink'
import type { Mode, UIMessage } from './useStream.ts'

export function ChatView({ messages, mode }: { messages: UIMessage[]; mode: Mode }) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>MeiCode 就绪——输入问题开始对话</Text>
        <Text dimColor>命令：/mode default|edits|plan|yolo 切换模式（/plan 等价 /mode plan）</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {m.role === 'user' ? (
            <Text color="cyan">❯ {m.text}</Text>
          ) : m.role === 'tool' ? (
            <Text dimColor>  {m.text}</Text>
          ) : (
            <>
              {m.thinking ? (
                <Text dimColor>
                  🧠 {m.thinking}
                  {mode === 'streaming' ? '▍' : ''}
                </Text>
              ) : null}
              <Text>{m.text || (mode === 'streaming' ? '…' : '')}</Text>
            </>
          )}
        </Box>
      ))}
    </Box>
  )
}
