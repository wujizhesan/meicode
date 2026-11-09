import { createAgentEventHandler } from '../src/tui/agent-event-handler.ts'
import type { StreamBuffer } from '../src/tui/stream-buffer.ts'

const calls: string[] = []
const summaries: string[] = []
const plan: string[] = []
const progress: number[] = []
const usage: number[] = []
let finish = ''

const stream: StreamBuffer = {
  appendText: (value) => calls.push(`text:${value}`),
  appendThinking: (value) => calls.push(`thinking:${value}`),
  flush: () => calls.push('flush'),
  dispose: () => {},
}

const handler = createAgentEventHandler({
  stream,
  planMode: true,
  persistIncremental: () => calls.push('persist'),
  appendAssistant: () => calls.push('assistant'),
  appendToolSummary: (summary) => summaries.push(summary),
  appendPlanText: (text) => plan.push(text),
  updateProgress: (event) => progress.push(event.round),
  addUsage: (event) => usage.push(event.inputTokens + event.outputTokens),
  finish: (event, toolCallCount) => { finish = `${event.reason}:${toolCallCount}` },
})

handler.handle({ type: 'progress', round: 1, max: 4, status: 'starting' })
handler.handle({ type: 'progress', round: 1, max: 4, status: 'running' })
handler.handle({ type: 'text', text: 'plan step' })
handler.handle({ type: 'thinking', text: 'reasoning' })
handler.handle({ type: 'tool_call', id: 'one', name: 'read_file', args: {} })
handler.handle({ type: 'tool_result', id: 'one', name: 'read_file', success: true, summary: 'ok' })
handler.handle({ type: 'usage', round: 1, inputTokens: 7, outputTokens: 3 })
handler.handle({ type: 'progress', round: 2, max: 4, status: 'starting' })
handler.handle({ type: 'tool_call', id: 'two', name: 'run_command', args: {} })
handler.handle({ type: 'tool_result', id: 'two', name: 'run_command', success: false, summary: 'failed' })
handler.handle({ type: 'done', reason: 'tool_failures', rounds: 2, totalTokens: 10, errorMessage: 'failed' })

if (calls.filter((item) => item === 'assistant').length !== 2) throw new Error(`assistant rounds changed: ${calls.join(',')}`)
if (calls.filter((item) => item === 'persist').length !== 3) throw new Error(`incremental persistence changed: ${calls.join(',')}`)
if (plan.join('') !== 'plan step') throw new Error(`plan text was not captured: ${plan.join('')}`)
if (progress.join(',') !== '1,1,2') throw new Error(`progress events changed: ${progress.join(',')}`)
if (usage.join(',') !== '10') throw new Error(`usage event changed: ${usage.join(',')}`)
if (summaries[0] !== '🔧 [1] read_file ✓') throw new Error(`first tool summary changed: ${summaries[0]}`)
if (summaries[1] !== '🔧 [1] run_command ✗') throw new Error(`second tool summary changed: ${summaries[1]}`)
if (finish !== 'tool_failures:2' || handler.toolCallCount() !== 2) throw new Error(`finish state changed: ${finish}`)

console.log('agent_event_handler_test passed')
