import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentRuntimeContext } from '../src/runtime/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { History } from '../src/session/history.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'

class SummaryProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: '压缩摘要' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_runtime_context')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const history = new History()
for (let i = 0; i < 12; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}:${'x'.repeat(300)}` })
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const context = createAgentRuntimeContext({
  provider: new SummaryProvider(),
  history,
  engine,
  cwd: root,
  contextWindow: 1000,
  sessionId: 'runtime-context-test',
})

if (context.permission?.mode !== 'unattended') throw new Error('公共运行时默认权限不是 unattended')
if (context.rootLock !== root) throw new Error('公共运行时未锁定工作目录')
if (!context.beforeRequest || !context.afterRequest || !context.contextBudget || !context.spill) throw new Error('公共运行时缺少上下文管理挂钩')
context.afterRequest(456, history.length)
if (context.contextBudget().lastInputTokens !== 456) throw new Error('公共运行时未记录输入 token')
const structureVersion = history.structureVersion
await context.beforeRequest('manual')
if (history.structureVersion <= structureVersion || !history.view().some((message) => message.content.includes('压缩摘要'))) {
  throw new Error('公共运行时未执行上下文压缩')
}

rmSync(root, { recursive: true, force: true })
console.log('runtime_context_test passed')
