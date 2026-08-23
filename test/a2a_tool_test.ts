import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createA2aServer } from '../src/a2a.ts'
import { createA2aTools } from '../src/a2a/tools.ts'
import { parseA2aAgents } from '../src/a2a/config.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(_messages: ChatMessage[], _opts: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: 'remote result' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_a2a_tool')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const server = createA2aServer({ provider: new FakeProvider(), registry: new ToolRegistry(), engine, cwd: process.cwd(), authToken: 'secret' })
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('A2A tool fixture 未监听')
const base = `http://127.0.0.1:${address.port}`

const parsed = parseA2aAgents(
  { remote: { url: base, token: 'secret', binding: 'jsonrpc' } },
  [{ name: 'bad', url: 'file:///tmp/nope' }],
)
if (parsed.agents.length !== 1 || parsed.agents[0].binding !== 'jsonrpc' || parsed.skipped.length !== 1) throw new Error('A2A Agent 配置解析失败')

const tools = createA2aTools(parsed.agents)
const send = tools.find((tool) => tool.name === 'a2a_send_message')
const get = tools.find((tool) => tool.name === 'a2a_get_task')
const list = tools.find((tool) => tool.name === 'a2a_list_tasks')
if (!send || !get || !list) throw new Error('A2A 工具未注册完整')
const sendResult = await send.execute({ agent: 'remote', message: 'hello remote' }, { cwd: process.cwd() })
if (!sendResult.success) throw new Error(`A2A 工具发送失败: ${sendResult.error}`)
const taskId = JSON.parse(sendResult.output).taskId as string
const getResult = await get.execute({ agent: 'remote', task_id: taskId }, { cwd: process.cwd() })
if (!getResult.success || !getResult.output.includes(taskId)) throw new Error('A2A 工具查询失败')
const listResult = await list.execute({ agent: 'remote', page_size: 1 }, { cwd: process.cwd() })
if (!listResult.success || !listResult.output.includes(taskId)) throw new Error('A2A 工具列表失败')
const unknownResult = await send.execute({ agent: 'unknown', message: 'x' }, { cwd: process.cwd() })
if (unknownResult.success || !unknownResult.error?.includes('未配置')) throw new Error('A2A 工具未限制白名单')

server.closeAllConnections()
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
rmSync(root, { recursive: true, force: true })
console.log('a2a_tool_test passed')
