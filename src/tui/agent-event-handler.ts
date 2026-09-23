import type { AgentEvent } from '../agent/events.ts'
import type { StreamBuffer } from './stream-buffer.ts'
import { formatRoundTools } from './stream-presentation.ts'
import type { RoundTool } from './stream-presentation.ts'

type ProgressEvent = Extract<AgentEvent, { type: 'progress' }>
type UsageEvent = Extract<AgentEvent, { type: 'usage' }>
type DoneEvent = Extract<AgentEvent, { type: 'done' }>

export interface AgentEventHandlerOptions {
  stream: StreamBuffer
  planMode: boolean
  persistIncremental(): void
  appendAssistant(): void
  appendToolSummary(summary: string): void
  appendPlanText(text: string): void
  updateProgress(event: ProgressEvent): void
  addUsage(event: UsageEvent): void
  finish(event: DoneEvent, toolCallCount: number): void
}

export interface AgentEventHandler {
  handle(event: AgentEvent): void
  flushTools(): void
  toolCallCount(): number
}

export function createAgentEventHandler(options: AgentEventHandlerOptions): AgentEventHandler {
  let lastRound = 0
  let calls = 0
  let roundTools: RoundTool[] = []

  const flushTools = (): void => {
    if (roundTools.length === 0) return
    options.appendToolSummary(formatRoundTools(roundTools))
    roundTools = []
  }

  const handle = (event: AgentEvent): void => {
    if (event.type === 'progress' && event.round !== lastRound) {
      options.stream.flush()
      options.persistIncremental()
      flushTools()
      lastRound = event.round
      options.appendAssistant()
    }

    if (event.type === 'text') {
      if (options.planMode) options.appendPlanText(event.text)
      options.stream.appendText(event.text)
      return
    }
    if (event.type === 'thinking') {
      options.stream.appendThinking(event.text)
      return
    }
    if (event.type === 'tool_call') {
      calls++
      roundTools.push({ id: event.id, name: event.name, status: 'running' })
      return
    }
    if (event.type === 'tool_result') {
      const tool = roundTools.find((item) => item.id === event.id)
      if (tool) tool.status = event.success ? 'ok' : 'fail'
      return
    }
    if (event.type === 'progress') {
      options.updateProgress(event)
      return
    }
    if (event.type === 'usage') {
      options.addUsage(event)
      return
    }

    options.stream.flush()
    options.persistIncremental()
    flushTools()
    options.finish(event, calls)
  }

  return { handle, flushTools, toolCallCount: () => calls }
}
