import { executeToolCall } from '../src/agent/tool-execution.ts'
import type { PermissionEngineLike } from '../src/permission/types.ts'
import { elicitTool } from '../src/tools/elicit.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { Tool } from '../src/tools/index.ts'
import { InteractionQueue } from '../src/tui/interaction-queue.ts'

const queue = new InteractionQueue<string, string | null>()
const snapshots: string[] = []
const unsubscribe = queue.subscribe((pending) => snapshots.push(pending.join(',')))
const first = queue.request('first')
const second = queue.request('second')
if (queue.snapshot().join(',') !== 'first,second') throw new Error('interaction queue did not preserve order')
if (!queue.resolveNext('accepted') || await first !== 'accepted') throw new Error('first interaction did not resolve')
if (queue.resolveAll(null) !== 1 || await second !== null) throw new Error('remaining interactions were not cancelled')
if (queue.snapshot().length !== 0) throw new Error('interaction queue was not cleared')
unsubscribe()
const snapshotsBefore = snapshots.length
const detached = queue.request('detached')
queue.resolveAll(null)
await detached
if (snapshots.length !== snapshotsBefore) throw new Error('unsubscribed listener was notified')

const queuedAbort = new AbortController()
const abortedInteraction = queue.request('abortable', { signal: queuedAbort.signal, response: null })
queuedAbort.abort()
if (await abortedInteraction !== null || queue.snapshot().length !== 0) {
  throw new Error('abort signal did not remove queued interaction')
}
const alreadyAborted = new AbortController()
alreadyAborted.abort()
if (await queue.request('never-queued', { signal: alreadyAborted.signal, response: null }) !== null || queue.snapshot().length !== 0) {
  throw new Error('already-aborted interaction was enqueued')
}

let toolExecuted = false
let askStarted = false
const guardedTool: Tool = {
  name: 'guarded_tool',
  description: 'guarded',
  parameters: { type: 'object', properties: {} },
  async execute() {
    toolExecuted = true
    return { success: true, output: 'executed' }
  },
}
const registry = new ToolRegistry()
registry.register(guardedTool)
const engine: PermissionEngineLike = {
  match: () => null,
  addSessionRule: () => {},
  appendProjectRule: () => {},
}
const permissionAbort = new AbortController()
const permissionResult = executeToolCall(
  { type: 'tool_call', id: 'permission', name: 'guarded_tool', arguments: {} },
  registry,
  {
    cwd: process.cwd(),
    signal: permissionAbort.signal,
    permission: { mode: 'default', engine },
    ask: async () => {
      askStarted = true
      return new Promise(() => {})
    },
  },
)
await new Promise<void>((resolve) => setImmediate(resolve))
if (!askStarted) throw new Error('permission prompt did not start')
permissionAbort.abort()
const denied = await permissionResult
if (denied.success || !denied.error?.includes('用户拒绝') || toolExecuted) {
  throw new Error(`permission abort did not deny pending tool: ${JSON.stringify(denied)}`)
}

const preAbortedPermission = new AbortController()
preAbortedPermission.abort()
let lateAskStarted = false
const preDenied = await executeToolCall(
  { type: 'tool_call', id: 'permission-pre-abort', name: 'guarded_tool', arguments: {} },
  registry,
  {
    cwd: process.cwd(),
    signal: preAbortedPermission.signal,
    permission: { mode: 'default', engine },
    ask: async () => {
      lateAskStarted = true
      return 'once'
    },
  },
)
if (preDenied.success || lateAskStarted) throw new Error('already-aborted permission created a new prompt')

const elicitAbort = new AbortController()
const elicited = elicitTool.execute(
  { question: 'continue?' },
  {
    cwd: process.cwd(),
    signal: elicitAbort.signal,
    elicit: async () => new Promise(() => {}),
  },
)
elicitAbort.abort()
const elicitResult = await elicited
if (elicitResult.success || !elicitResult.error?.includes('用户未回答')) {
  throw new Error(`elicit abort did not release pending prompt: ${JSON.stringify(elicitResult)}`)
}

console.log('interaction_cancellation_test passed')
