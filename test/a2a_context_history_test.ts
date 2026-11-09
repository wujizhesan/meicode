// 上下文续接：同一个 contextId 的多次任务，只有显式带 x-meicode-context-history: 1
// 才会把历史灌进模型上下文；不带就仍是全新对话（保持老客户端行为不变）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}: ${(error as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const seen: ChatMessage[][] = []

const provider: Provider = {
  protocol: 'openai',
  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    seen.push(structuredClone(messages))
    yield { type: 'text', text: `第 ${seen.length} 次回复` }
    yield { type: 'done' }
  },
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-context-'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const store = new A2aTaskStore(join(root, 'tasks'))
let server: ReturnType<typeof createA2aServer> | undefined

async function send(text: string, contextHistory: boolean, contextId: string): Promise<void> {
  assert(server, '服务未启动')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法获取端口')
  const response = await fetch(`http://127.0.0.1:${address.port}/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(contextHistory ? { 'x-meicode-context-history': '1' } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `req-${Math.random().toString(36).slice(2)}`,
      method: 'message/stream',
      params: {
        message: {
          messageId: `msg-${Math.random().toString(36).slice(2)}`,
          role: 'ROLE_USER',
          parts: [{ kind: 'text', text }],
          contextId,
        },
      },
    }),
  })
  if (!response.ok) throw new Error(`请求失败: ${response.status}`)
  await response.text()
}

try {
  server = createA2aServer({
    provider,
    registry: new ToolRegistry(),
    engine,
    cwd: root,
    taskStore: store,
    taskTtlMs: 60_000,
    maxCachedCompletedTasks: 8,
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))

  await check('不带开关时，同 contextId 的第二个任务仍是干净上下文', async () => {
    await send('CTX-A 第一问', false, 'ctx-a')
    await send('CTX-A 第二问', false, 'ctx-a')
    const second = seen[1].map((message) => message.content).join('\n')
    assert(second.includes('CTX-A 第二问'), '缺少本轮用户消息')
    assert(!second.includes('CTX-A 第一问'), `不该带上一轮（实际: ${second.slice(0, 120)}）`)
  })

  await check('带开关时，历史被灌进模型上下文且顺序正确', async () => {
    await send('CTX-B 第一问', false, 'ctx-b')
    await send('CTX-B 第二问', true, 'ctx-b')
    const last = seen[seen.length - 1]
    const contents = last.map((message) => `${message.role}:${message.content}`)
    const firstIndex = contents.findIndex((item) => item.includes('CTX-B 第一问'))
    const answerIndex = contents.findIndex((item) => item.includes('第 3 次回复') || item.includes('第 4 次回复'))
    const askIndex = contents.findIndex((item) => item.includes('CTX-B 第二问'))
    assert(firstIndex >= 0, `缺少上一轮提问: ${contents.join(' | ').slice(0, 200)}`)
    assert(answerIndex > firstIndex, '上一轮回复应排在提问之后')
    assert(askIndex > answerIndex, '本轮提问应排在最后')
  })

  await check('不同 contextId 之间互不串味', async () => {
    await send('CTX-C 独立问题', true, 'ctx-c')
    const last = seen[seen.length - 1].map((message) => message.content).join('\n')
    assert(!last.includes('CTX-B 第一问'), `串到了 ctx-b: ${last.slice(0, 120)}`)
  })
} finally {
  if (server) await closeHttpServer(server)
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
