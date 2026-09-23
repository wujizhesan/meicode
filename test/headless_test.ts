import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { runHeadless } from '../src/runtime/headless.ts'
import { SessionStore } from '../src/memory/index.ts'
import { History } from '../src/session/history.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { HookEngine } from '../src/hook/index.ts'
import type { RuleEngine } from '../src/permission/index.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { TeamManager } from '../src/team/index.ts'

const root = join(import.meta.dirname, 'fixtures_headless')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const store = new SessionStore(join(root, 'sessions'))
store.replace('headless-conflict', [{ role: 'user', content: 'existing' }])
const external = new SessionStore(join(root, 'sessions'))
external.recoverById('headless-conflict')
let externalWriteDone = false
const provider: Provider = {
  protocol: 'openai',
  async *streamChat(_messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    if (!externalWriteDone) {
      externalWriteDone = true
      external.append('headless-conflict', [{ role: 'assistant', content: 'external' }])
    }
    yield { type: 'text', text: 'headless result' }
    yield { type: 'done' }
  },
}
const history = new History()
history.push({ role: 'user', content: 'existing' })
const hooks = {
  fire: async () => {},
  collectInjections: () => [],
  resetRound: () => {},
} as unknown as HookEngine
const team = { listGroups: () => [] } as unknown as TeamManager
const originalLog = console.log
const originalWarn = console.warn
const originalWrite = process.stdout.write
const warnings: string[] = []
console.log = () => {}
console.warn = (message?: unknown) => warnings.push(String(message))
process.stdout.write = (() => true) as typeof process.stdout.write
try {
  await runHeadless('execute', {
    provider,
    history,
    registry: new ToolRegistry(),
    engine: {} as RuleEngine,
    memory: { sessionStore: store, sessionId: 'headless-conflict' },
    teamManager: team,
    hooks,
    contextWindow: 4096,
    yolo: false,
  })
} finally {
  console.log = originalLog
  console.warn = originalWarn
  process.stdout.write = originalWrite
}

const copy = store.listSessions(20).find((session) => session.id.startsWith('headless-conflict-conflict-'))
if (!copy || store.recoverById(copy.id)?.messages.at(-1)?.content !== 'headless result') {
  throw new Error('headless 会话冲突未保全本次结果')
}
if (!warnings.some((message) => message.includes(copy.id)) || store.recoverById('headless-conflict')?.messages.at(-1)?.content !== 'external') {
  throw new Error('headless 会话冲突未提示副本或覆盖了原会话')
}

rmSync(root, { recursive: true, force: true })
console.log('headless_test passed')
