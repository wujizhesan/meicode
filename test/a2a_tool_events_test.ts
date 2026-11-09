// A2A 工具事件（opt-in）：只有带 x-meicode-tool-events: 1 的请求才会收到 meicode/tool artifact，
// 默认请求的产物形态保持不变——这条通道是给 Web 控制台渲工具卡片用的。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { editFileTool } from '../src/tools/edit_file.ts'
import type { Tool } from '../src/tools/types.ts'

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

// 第一轮要工具，第二轮收尾：正好覆盖 tool_call + tool_result 两个事件。
// 用最后一条用户消息区分要哪个工具，这样一个 provider 能服务多个用例。
class ToolCallingProvider implements Provider {
  readonly protocol = 'openai' as const
  private turns = new Map<string, number>()

  async *streamChat(messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
    const key = String(lastUser)
    const turn = (this.turns.get(key) ?? 0) + 1
    this.turns.set(key, turn)
    if (turn === 1) {
      if (key.includes('EDIT_FILE')) {
        yield { type: 'tool_call', id: 'call_edit_1', name: 'edit_file', arguments: { path: 'sample.txt', old_text: 'b', new_text: 'B' } }
      } else {
        yield { type: 'tool_call', id: 'call_probe_1', name: 'echo_probe', arguments: { text: 'a'.repeat(120) } }
      }
    } else {
      yield { type: 'text', text: '工具跑完了。' }
    }
    yield { type: 'done' }
  }
}

const probe: Tool = {
  name: 'echo_probe',
  description: '测试用工具：原样返回 text',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as Tool['parameters'],
  async execute(args) {
    return { success: true, output: String(args.text ?? '') }
  },
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-tools-'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const registry = new ToolRegistry()
registry.register(probe)
registry.register(editFileTool)
const store = new A2aTaskStore(join(root, 'tasks'))
let server: ReturnType<typeof createA2aServer> | undefined

/** SSE result 里本用例关心的部分（工具产物 / 正文产物） */
interface ArtifactEvent {
  artifactUpdate?: {
    artifact: { artifactId: string; name?: string; parts: Array<{ kind: 'text'; text: string }> }
  }
}

/** 发一次流式请求，返回所有 SSE result 负载 */
async function streamOnce(withToolEvents: boolean, userText = '跑一下 echo_probe'): Promise<ArtifactEvent[]> {
  assert(server, '服务未启动')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法获取监听端口')
  const response = await fetch(`http://127.0.0.1:${address.port}/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(withToolEvents ? { 'x-meicode-tool-events': '1' } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `req-${Date.now()}`,
      method: 'message/stream',
      params: {
        message: {
          messageId: `msg-${Math.random().toString(36).slice(2)}`,
          role: 'ROLE_USER',
          parts: [{ kind: 'text', text: userText }],
        },
      },
    }),
  })
  if (!response.ok || !response.body) throw new Error(`请求失败: ${response.status}`)
  const text = await response.text()
  const events: ArtifactEvent[] = []
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find((item) => item.startsWith('data:'))
    if (!line) continue
    const payload = JSON.parse(line.slice(5).trim()) as { result?: ArtifactEvent }
    if (payload.result) events.push(payload.result)
  }
  return events
}

try {
  server = createA2aServer({
    provider: new ToolCallingProvider(),
    registry,
    engine,
    cwd: root,
    taskStore: store,
    taskTtlMs: 60_000,
    maxCachedCompletedTasks: 4,
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))

  await check('opt-in 时下发 start/end 两帧工具事件', async () => {
    const events = await streamOnce(true)
    const tools = events.flatMap((event) => {
      const artifact = event.artifactUpdate?.artifact
      if (artifact?.name !== 'meicode/tool') return []
      return [JSON.parse(artifact.parts[0].text) as Record<string, unknown>]
    })
    assert(tools.length === 2, `工具事件数量应为 2，实际 ${tools.length}`)

    const [start, end] = tools
    assert(start.phase === 'start', `第一帧应为 start，实际 ${String(start.phase)}`)
    assert(start.tool === 'echo_probe', `工具名不符: ${String(start.tool)}`)
    assert(String(start.args).includes('text='), `参数摘要缺少键名: ${String(start.args)}`)
    // 120 个字符要被截断，否则事件流会被大参数撑爆
    assert(String(start.args).length <= 210, `参数摘要未截断: ${String(start.args).length}`)

    assert(end.phase === 'end', `第二帧应为 end，实际 ${String(end.phase)}`)
    assert(end.success === true, '工具应执行成功')
    assert(typeof end.durationMs === 'number' && end.durationMs >= 0, '缺少耗时')
    // 工具正文要能透出，否则前端只能看到「成功」两个字
    assert(typeof end.output === 'string' && String(end.output).length > 0, '缺少工具输出')
    assert(String(end.output).startsWith('aaa'), `工具输出内容不符: ${String(end.output).slice(0, 20)}`)
  })

  await check('默认请求不受影响：没有 meicode/tool 产物', async () => {
    const events = await streamOnce(false)
    const tools = events.filter((event) => event.artifactUpdate?.artifact?.name === 'meicode/tool')
    assert(tools.length === 0, `未声明开关却收到 ${tools.length} 帧工具事件`)
    const body = events.find((event) => event.artifactUpdate?.artifact?.name === 'response.txt')
    assert(body, '正文产物缺失')
  })
  await check('编辑类工具把 unified diff 一并下发', async () => {
    writeFileSync(join(root, 'sample.txt'), 'a\nb\nc\n', 'utf8')
    const events = await streamOnce(true, 'EDIT_FILE: 把 b 改成 B')
    const payloads = events.flatMap((event) => {
      const artifact = event.artifactUpdate?.artifact
      if (artifact?.name !== 'meicode/tool') return []
      return [JSON.parse(artifact.parts[0].text) as Record<string, unknown>]
    })
    const end = payloads.find((payload) => payload.phase === 'end')
    assert(end, '缺少工具结束帧')
    assert(end.success === true, `编辑应成功: ${String(end.summary)}`)
    const diff = String(end.diff ?? '')
    assert(diff.includes('-b') && diff.includes('+B'), `diff 内容不符: ${diff}`)
    assert(diff.startsWith('@@'), `diff 缺少 hunk 头: ${diff}`)
  })
} finally {
  if (server) await closeHttpServer(server)
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
