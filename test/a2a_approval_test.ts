// A2A 交互审批：带 x-meicode-interactive: 1 时，权限询问变成 meicode/ask 事件，
// 客户端回传 decision 后工具才继续；不带该头则维持无人值守（直接拒绝）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'

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

interface Frame {
  artifactUpdate?: { artifact: { artifactId: string; name?: string; parts: Array<{ text: string }> } }
}

// 第一轮要求执行命令（默认模式下属于需要确认的动作），第二轮收尾
class CommandProvider implements Provider {
  readonly protocol = 'openai' as const
  private turns = new Map<string, number>()

  async *streamChat(messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    const lastUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '')
    const turn = (this.turns.get(lastUser) ?? 0) + 1
    this.turns.set(lastUser, turn)
    if (turn === 1) {
      yield { type: 'tool_call', id: 'call_cmd_1', name: 'run_command', arguments: { command: 'echo hello' } }
    } else {
      yield { type: 'text', text: '结束。' }
    }
    yield { type: 'done' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-approval-'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const registry = new ToolRegistry()
for (const tool of createTools({ cwd: root })) registry.register(tool)
const store = new A2aTaskStore(join(root, 'tasks'))
let server: ReturnType<typeof createA2aServer> | undefined

function endpointUrl(): string {
  assert(server, '服务未启动')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法获取监听端口')
  return `http://127.0.0.1:${address.port}/a2a`
}

function rpcBody(userText: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: `req-${Math.random().toString(36).slice(2)}`,
    method: 'message/stream',
    params: {
      message: {
        messageId: `msg-${Math.random().toString(36).slice(2)}`,
        role: 'ROLE_USER',
        parts: [{ kind: 'text', text: userText }],
      },
    },
  })
}

function parseFrames(buffer: string, sink: Array<Record<string, unknown>>): string {
  let rest = buffer
  let index = rest.indexOf('\n\n')
  while (index >= 0) {
    const frame = rest.slice(0, index)
    rest = rest.slice(index + 2)
    const line = frame.split('\n').find((item) => item.startsWith('data:'))
    if (line) {
      const payload = JSON.parse(line.slice(5).trim()) as { result?: Record<string, unknown> }
      if (payload.result) sink.push(payload.result)
    }
    index = rest.indexOf('\n\n')
  }
  return rest
}

function findAsk(events: Array<Record<string, unknown>>): { approvalId: string; tool: string } | null {
  for (const event of events) {
    const artifact = (event as Frame).artifactUpdate?.artifact
    if (artifact?.name !== 'meicode/ask') continue
    return JSON.parse(artifact.parts[0].text) as { approvalId: string; tool: string }
  }
  return null
}

function findToolEnd(events: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (const event of events) {
    const artifact = (event as Frame).artifactUpdate?.artifact
    if (artifact?.name !== 'meicode/tool') continue
    const payload = JSON.parse(artifact.parts[0].text) as Record<string, unknown>
    if (payload.phase === 'end') return payload
  }
  return null
}

try {
  server = createA2aServer({
    provider: new CommandProvider(),
    registry,
    engine,
    cwd: root,
    taskStore: store,
    taskTtlMs: 60_000,
    maxCachedCompletedTasks: 4,
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))

  await check('交互模式下先发 ask，答复拒绝后工具被判拒绝', async () => {
    const response = await fetch(endpointUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-meicode-tool-events': '1',
        'x-meicode-interactive': '1',
      },
      body: rpcBody('跑一下 echo hello'),
    })
    assert(response.body, '没有响应流')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const events: Array<Record<string, unknown>> = []
    let buffer = ''

    // 读到 ask 为止（此时服务端在等答复，流不会结束）
    let ask: { approvalId: string; tool: string } | null = null
    while (!ask) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = parseFrames(buffer, events)
      ask = findAsk(events)
      if (!ask && events.length > 200) throw new Error('事件过多仍未收到 ask')
    }
    assert(ask, '未收到 meicode/ask 事件')
    assert(ask!.tool === 'run_command', `ask 里的工具名不符: ${ask!.tool}`)

    const answer = await fetch(endpointUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'approve-1',
        method: 'meicode/approval',
        params: { approvalId: ask!.approvalId, decision: 'deny' },
      }),
    })
    assert(answer.ok, `审批回传失败: ${answer.status}`)

    // 继续读完整条流
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = parseFrames(buffer, events)
    }

    const end = findToolEnd(events)
    assert(end, '缺少工具结束帧')
    assert(end!.success === false, `拒绝后工具不应成功: ${JSON.stringify(end)}`)
    assert(String(end!.summary).includes('拒绝'), `结束帧摘要应说明被拒绝: ${String(end!.summary)}`)
  })

  await check('不带交互头时维持无人值守：不发 ask', async () => {
    const response = await fetch(endpointUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-meicode-tool-events': '1',
      },
      body: rpcBody('跑一下 echo 世界'),
    })
    const text = await response.text()
    const events: Array<Record<string, unknown>> = []
    parseFrames(`${text}\n\n`, events)

    assert(findAsk(events) === null, '无人值守模式不应发出审批请求')
    // 无人值守并不是「全拒」：只读/安全命令按策略直接放行，这里只断言它没有回头问人
    const end = findToolEnd(events)
    assert(end, '缺少工具结束帧')
  })
} finally {
  if (server) await closeHttpServer(server)
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
