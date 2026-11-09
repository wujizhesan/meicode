// tasks/list 的服务端搜索：按任务正文（用户与助手消息）匹配，大小写不敏感
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aTaskStore, createA2aServer } from '../src/a2a.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { RuleEngine } from '../src/permission/index.ts'
import { closeHttpServer } from '../src/runtime/service-host.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { A2ATask } from '../src/a2a/types.ts'

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

const provider: Provider = {
  protocol: 'openai',
  async *streamChat(_messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: '好的，已处理。' }
    yield { type: 'done' }
  },
}

const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-search-'))
const engine = new RuleEngine(join(root, 'user.yaml'), join(root, 'project.yaml'), join(root, 'local.yaml'))
engine.loadAll()
const store = new A2aTaskStore(join(root, 'tasks'))
let server: ReturnType<typeof createA2aServer> | undefined

function endpoint(): string {
  assert(server, '服务未启动')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法获取端口')
  return `http://127.0.0.1:${address.port}/a2a`
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
  })
  const payload = await response.json() as { result?: T; error?: { message?: string } }
  if (payload.error) throw new Error(payload.error.message)
  assert(payload.result, '缺少 result')
  return payload.result
}

async function send(text: string): Promise<void> {
  await call('message/send', {
    message: {
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      role: 'ROLE_USER',
      parts: [{ kind: 'text', text }],
    },
  })
}

async function search(query?: string): Promise<A2ATask[]> {
  const result = await call<{ tasks: A2ATask[]; totalSize: number }>('tasks/list', {
    pageSize: 50,
    ...(query === undefined ? {} : { query }),
  })
  return result.tasks
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

  await send('把服务部署到测试环境')
  await send('修复登录页的 bug')
  await send('更新 README 文档')

  await check('按正文关键词命中', async () => {
    const tasks = await search('登录')
    assert(tasks.length === 1, `应命中 1 条，实际 ${tasks.length}`)
    const text = tasks[0].history.map((message) => message.parts.map((part) => part.text).join('')).join('\n')
    assert(text.includes('登录页'), `命中内容不符: ${text.slice(0, 40)}`)
  })

  await check('大小写不敏感', async () => {
    const tasks = await search('readme')
    assert(tasks.length === 1, `应命中 1 条，实际 ${tasks.length}`)
  })

  await check('空查询等于不过滤', async () => {
    const all = await search()
    const blank = await search('   ')
    assert(all.length === 3, `应为 3 条，实际 ${all.length}`)
    assert(blank.length === 3, `空白查询不应过滤，实际 ${blank.length}`)
  })

  await check('无命中返回空', async () => {
    const tasks = await search('绝对不会出现的词')
    assert(tasks.length === 0, `应无命中，实际 ${tasks.length}`)
  })
} finally {
  if (server) await closeHttpServer(server)
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
