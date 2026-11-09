import { approvalPattern, executeToolBatch, executeToolCall, normalizeArgs } from '../src/agent/tool-execution.ts'
import type { StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { Tool, ToolContext } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'

const normalized = normalizeArgs({ path: 'keep.ts', file_path: 'ignored.ts', cmd: 'npm  test', oldText: 'a' })
if (normalized.path !== 'keep.ts' || normalized.command !== 'npm  test' || normalized.old_text !== 'a') {
  throw new Error(`argument normalization mismatch: ${JSON.stringify(normalized)}`)
}
if (approvalPattern('run_command', normalized) !== 'npm test') throw new Error('command approval pattern was not normalized')
if (approvalPattern('run_command', { command: 'git', args: ['push', '--force'] }) !== 'argv:["git","push","--force"]') {
  throw new Error('argv approval was not scoped to the complete invocation')
}
if (approvalPattern('write_file', { path: 'a b.ts' }) !== 'a b.ts') throw new Error('path approval pattern changed spaces')

const registry = new ToolRegistry()
let activeReads = 0
let maxActiveReads = 0
let writeStartedWithReads = false
let capturedPath = ''
const readTool: Tool = {
  name: 'read_file',
  description: 'read',
  parameters: { type: 'object', properties: {} },
  async execute(args) {
    capturedPath = String(args.path ?? '')
    activeReads++
    maxActiveReads = Math.max(maxActiveReads, activeReads)
    await new Promise((resolve) => setTimeout(resolve, 5))
    activeReads--
    return { success: true, output: capturedPath }
  },
}
const writeTool: Tool = {
  name: 'write_file',
  description: 'write',
  parameters: { type: 'object', properties: {} },
  async execute() {
    writeStartedWithReads = activeReads > 0
    return { success: true, output: 'written' }
  },
}
registry.register(readTool)
registry.register(writeTool)
const context: ToolContext = { cwd: process.cwd() }

const single = await executeToolCall(
  { type: 'tool_call', id: 'single', name: 'read_file', arguments: { file_path: 'alias.ts' } },
  registry,
  context,
)
if (!single.success || capturedPath !== 'alias.ts') throw new Error('tool call did not receive normalized arguments')
const missing = await executeToolCall(
  { type: 'tool_call', id: 'missing', name: 'missing', arguments: {} },
  registry,
  context,
)
if (missing.success || !missing.error?.includes('未找到工具')) throw new Error('unknown tool result mismatch')

const calls: Extract<StreamEvent, { type: 'tool_call' }>[] = [
  { type: 'tool_call', id: 'read-1', name: 'read_file', arguments: { path: 'one' } },
  { type: 'tool_call', id: 'read-2', name: 'read_file', arguments: { path: 'two' } },
  { type: 'tool_call', id: 'write-1', name: 'write_file', arguments: { path: 'out' } },
]
const executed = await executeToolBatch(calls, registry, context, () => {})
if (maxActiveReads < 2) throw new Error('read-only tools did not execute concurrently')
if (writeStartedWithReads) throw new Error('write tool overlapped pending reads')
if (executed.map((item) => item.call.id).join(',') !== 'read-1,read-2,write-1') throw new Error('batch result order changed')

let onceAsks = 0
const onceContext: ToolContext = {
  cwd: process.cwd(),
  sessionId: 'permission-once',
  permission: { mode: 'default', engine: new RuleEngine('', '', '') },
  ask: async () => { onceAsks++; return 'once' },
}
for (const id of ['once-1', 'once-2']) {
  const result = await executeToolCall({ type: 'tool_call', id, name: 'write_file', arguments: { path: 'once.txt' } }, registry, onceContext)
  if (!result.success) throw new Error(`once approval did not execute: ${result.error}`)
}
if (onceAsks !== 2) throw new Error(`once approval was cached: asks=${onceAsks}`)

let sessionAsks = 0
const sessionEngine = new RuleEngine('', '', '')
const sessionContext = (sessionId: string): ToolContext => ({
  cwd: process.cwd(),
  sessionId,
  permission: { mode: 'default', engine: sessionEngine },
  ask: async () => { sessionAsks++; return 'session' },
})
await executeToolCall({ type: 'tool_call', id: 'session-a-1', name: 'write_file', arguments: { path: 'session.txt' } }, registry, sessionContext('session-a'))
await executeToolCall({ type: 'tool_call', id: 'session-a-2', name: 'write_file', arguments: { path: 'session.txt' } }, registry, sessionContext('session-a'))
await executeToolCall({ type: 'tool_call', id: 'session-b-1', name: 'write_file', arguments: { path: 'session.txt' } }, registry, sessionContext('session-b'))
if (sessionAsks !== 2) throw new Error(`session approval scope mismatch: asks=${sessionAsks}`)

console.log('tool_execution_test passed')
