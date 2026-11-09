import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { runAgent } from '../src/agent/loop.ts'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider, ChatMessage } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { SubAgentManager, SubAgentStore, createSpawnAgentTool } from '../src/subagent/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { Tool, ToolContext } from '../src/tools/index.ts'

let passed = 0
let failed = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_fork_context_'))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fork 回归超时')), 3000)
    })])
  } finally { clearTimeout(timer) }
}

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function fixture(name: string) {
  const directory = join(root, name)
  mkdirSync(directory)
  const manager = new SubAgentManager({ builtin: join(directory, 'builtin'), user: join(directory, 'user'), project: join(directory, 'roles') }, null, new SubAgentStore(join(directory, 'store'), name))
  const registry = new ToolRegistry()
  const ctx: ToolContext = {
    cwd: directory, sessionId: name, agentId: 'parent-agent',
    permission: { mode: 'permissive', engine: { match: () => null, addSessionRule() {}, appendProjectRule() {} } },
  }
  return { manager, registry, ctx }
}

function tool(name: string, execute: Tool['execute'] = async () => ({ success: true, output: '读取完成' })): Tool {
  return { name, description: name, parameters: { type: 'object' }, execute }
}

try {
  await check('真实 spawn_agent 工具继承父历史尾部与本轮工具，拒绝子任务额外写入及嵌套派发', async () => {
    const f = fixture('real-tool')
    const history = new History()
    for (let i = 0; i < 12; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `父上下文-${i}` })
    const expectedTail = history.all().slice(-10)
    let mainRounds = 0
    let childRounds = 0
    let reads = 0
    let writes = 0
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages, options) {
        if (messages[0].content === 'PARENT-FORK-CONTEXT') {
          if (++mainRounds === 1) yield { type: 'tool_call', id: 'parent-fork', name: 'spawn_agent', arguments: { type: 'fork', prompt: '分支任务' } }
          else yield { type: 'text', text: '父任务完成' }
        } else {
          childRounds++
          assert.deepEqual(options.tools!.map((item) => item.function.name), ['read_file'])
          if (childRounds === 1) {
            assert.deepEqual(messages.filter((message) => message.content.startsWith('父上下文-')), expectedTail)
            assert(messages.some((message) => message.role === 'user' && message.content === '分支任务'))
            yield { type: 'tool_call', id: 'child-read', name: 'read_file', arguments: {} }
            yield { type: 'tool_call', id: 'child-write', name: 'write_file', arguments: {} }
          } else {
            assert(messages.some((message) => message.tool_call_id === 'child-write' && message.content.includes('不在本轮允许列表')))
            yield { type: 'text', text: '分支任务完成' }
          }
        }
        yield { type: 'done' }
      },
    }
    f.registry.register(tool('read_file', async () => { reads++; return { success: true, output: '读取完成' } }))
    f.registry.register(tool('write_file', async () => { writes++; return { success: true, output: '不应写入' } }))
    f.registry.register(tool('run_command'))
    f.registry.register(createSpawnAgentTool(f.manager, { provider, registry: f.registry }))
    try {
      const main = runAgent({ provider, registry: f.registry, history, ctx: f.ctx, systemPrompt: 'PARENT-FORK-CONTEXT', maxIterations: 3, mode: 'full', unknownToolLimit: 2, toolsOverride: f.registry.toOpenAITools().filter((item) => ['read_file', 'spawn_agent'].includes(item.function.name)) })
      for await (const _event of main.events) {}
      assert.equal((await bounded(main.done)).reason, 'complete')
      const records = f.manager.listRecords()
      assert.equal(records.length, 1)
      const result = await bounded(f.manager.waitFor(records[0].id, 2000))
      assert.equal(result.record?.status, 'done')
      assert.equal(childRounds, 2)
      assert.equal(reads, 1)
      assert.equal(writes, 0)
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('动态父工具列表按轮继承，下一次 fork 使用该轮声明的工具', async () => {
    const f = fixture('dynamic-tools')
    const history = new History()
    history.push({ role: 'user', content: '父任务' })
    let mainRounds = 0
    const childTools: string[][] = []
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages, options) {
        if (messages[0].content === 'PARENT-DYNAMIC-FORK') {
          mainRounds++
          if (mainRounds <= 2) yield { type: 'tool_call', id: `fork-${mainRounds}`, name: 'spawn_agent', arguments: { type: 'fork', prompt: `分支-${mainRounds}` } }
          else yield { type: 'text', text: '父任务完成' }
        } else {
          childTools.push(options.tools!.map((item) => item.function.name))
          yield { type: 'text', text: '分支完成' }
        }
        yield { type: 'done' }
      },
    }
    f.registry.register(tool('read_file'))
    f.registry.register(tool('custom_read'))
    f.registry.register(tool('write_file'))
    f.registry.register(createSpawnAgentTool(f.manager, { provider, registry: f.registry }))
    try {
      const main = runAgent({
        provider, registry: f.registry, history, ctx: f.ctx, systemPrompt: 'PARENT-DYNAMIC-FORK', maxIterations: 4, mode: 'full', unknownToolLimit: 2,
        resolveRequestOptions: () => ({ toolsOverride: f.registry.toOpenAITools().filter((item) => ['spawn_agent', mainRounds === 0 ? 'read_file' : 'custom_read'].includes(item.function.name)) }),
      })
      for await (const _event of main.events) {}
      assert.equal((await bounded(main.done)).reason, 'complete')
      for (const record of f.manager.listRecords()) await bounded(f.manager.waitFor(record.id, 2000))
      assert.equal(mainRounds, 3)
      assert.deepEqual(childTools, [['read_file'], ['custom_read']])
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('启动等待期间父历史与工具数组变化不污染已经提交的 fork 快照', async () => {
    const f = fixture('snapshot')
    const hooks = new HookEngine([])
    const started = deferred()
    const gate = deferred()
    hooks.fire = async (event) => { if (event === 'subagent_start') { started.resolve(); await gate.promise } }
    const parentHistory: ChatMessage[] = [
      { role: 'assistant', content: '已读取文件', tool_calls: [{ id: 'prior-read', name: 'read_file', arguments: '{"path":"original"}' }] },
      { role: 'tool', tool_call_id: 'prior-read', content: '原父结果' },
    ]
    const expected = structuredClone(parentHistory)
    const parentTools = [tool('read_file')]
    f.registry.register(parentTools[0])
    f.registry.register(tool('write_file'))
    let observed = false
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages, options) {
        assert.deepEqual(messages.filter((message) => message.tool_calls || message.role === 'tool'), expected)
        assert.deepEqual(options.tools!.map((item) => item.function.name), ['read_file'])
        observed = true
        yield { type: 'text', text: '独立执行完成' }
        yield { type: 'done' }
      },
    }
    try {
      const submitted = await f.manager.spawn({ type: 'fork', prompt: '分支任务', parentHistory, parentTools }, { provider, registry: f.registry, ctx: { ...f.ctx, hooks } })
      await bounded(started.promise)
      parentHistory[0].tool_calls![0].arguments = '{"path":"changed"}'
      parentHistory[1].content = '被修改的父结果'
      parentTools.push(f.registry.get('write_file')!)
      gate.resolve()
      const result = await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(result.record?.status, 'done')
      assert(observed)
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('显式空父工具列表不回退到内置工具，模型返回写调用也不会执行', async () => {
    const f = fixture('empty-tools')
    let rounds = 0
    let writes = 0
    f.registry.register(tool('write_file', async () => { writes++; return { success: true, output: '不应写入' } }))
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(_messages, options) {
        assert.deepEqual(options.tools, [])
        if (++rounds === 1) yield { type: 'tool_call', id: 'forbidden-write', name: 'write_file', arguments: {} }
        else yield { type: 'text', text: '完成' }
        yield { type: 'done' }
      },
    }
    try {
      const submitted = await f.manager.spawn({ type: 'fork', prompt: '任务', parentTools: [] }, { provider, registry: f.registry, ctx: f.ctx })
      const result = await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(result.record?.status, 'done')
      assert.equal(rounds, 2)
      assert.equal(writes, 0)
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('缺少父上下文时 spawn_agent 明确拒绝 fork，避免静默扩大工具范围', async () => {
    const f = fixture('missing-parent')
    let requests = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() { requests++; yield { type: 'done' } } }
    try {
      const result = await createSpawnAgentTool(f.manager, { provider, registry: f.registry }).execute({ type: 'fork', prompt: '任务' }, f.ctx)
      assert.equal(result.success, false)
      assert(result.error?.includes('父会话快照'))
      assert.equal(requests, 0)
      assert.deepEqual(f.manager.listRecords(), [])
    } finally { await bounded(f.manager.close(0)) }
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_fork_context_'))
  const verify = (directory: string) => {
    assert(!lstatSync(directory).isSymbolicLink())
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) verify(join(directory, entry.name))
    }
  }
  verify(target)
  rmSync(target, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
