export interface UIMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  thinking?: string
}

export type Mode = 'idle' | 'streaming' | 'error'
export type AgentMode = 'plan' | 'full'
export type UserMode = 'default' | 'edits' | 'plan' | 'yolo'
