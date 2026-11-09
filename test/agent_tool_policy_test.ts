import assert from 'node:assert/strict'
import { runAgent } from '../src/agent/loop.ts'
import type { AgentOptions } from '../src/agent/events.ts'
import { executeToolCall } from '../src/agent/tool-execution.ts'
import { estimateMessageTokens } from '../src/context/estimate.ts'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider, ProviderTool, StreamEvent } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
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
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Agent 未及时结束')), 2000) }),
    ])
  } finally { clearTimeout(timer) }
}

function call(name: string, id = name): Extract<StreamEvent, { type: 'tool_call' }> {
  return { type: 'tool_call', id, name, arguments: {} }
}

function fixture(source: Provider, extra: Partial<AgentOptions> = {}) {
  const history = new History()
  history.push({ role: 'user', content: '测试工具限制' })
  const registry = new ToolRegistry()
  let reads = 0
  let writes = 0
  registry.register({ name: 'read_file', description: '读取', parameters: { type: 'object' }, async execute() { reads++; return { success: true, output: '读取完成' } } })
  registry.register({ name: 'write_file', description: '计数', parameters: { type: 'object' }, async execute() { writes++; return { success: true, output: '写计数完成' } } })
  const opts: AgentOptions = { provider: source, history, registry, ctx: { cwd: process.cwd() }, mode: 'full', maxIterations: 4, unknownToolLimit: 2, systemPrompt: '测试', ...extra }
  return {
    history, registry,
    get reads() { return reads }, get writes() { return writes },
    opts,
  }
}

async function finish(opts: AgentOptions) {
  const agent = runAgent(opts)
  try { return await bounded(agent.done) }
  finally { agent.cancel(); await bounded(agent.done) }
}

for (const kind of ['plan', 'whitelist', 'empty-whitelist', 'plan-override', 'dynamic-empty'] as const) {
  await check(`${kind}: 未获本轮允许的写工具返回失败且不执行`, async () => {
    const advertised: string[][] = []
    let round = 0
    const source: Provider = {
      protocol: 'openai',
      async *streamChat(_messages, opts) {
        advertised.push(opts.tools!.map((tool) => tool.function.name))
        if (++round === 1) yield call('write_file')
        else yield { type: 'text', text: '已纠正调用' }
        yield { type: 'done' }
      },
    }
    const f = fixture(source)
    const allTools = f.registry.toOpenAITools()
    if (kind === 'plan' || kind === 'plan-override') f.opts.mode = 'plan'
    if (kind === 'whitelist') f.opts.toolsOverride = allTools.filter((tool) => tool.function.name === 'read_file')
    if (kind === 'empty-whitelist') f.opts.toolsOverride = []
    if (kind === 'plan-override') f.opts.toolsOverride = allTools
    if (kind === 'dynamic-empty') f.opts.resolveRequestOptions = () => ({ toolsOverride: [] })
    assert.equal((await finish(f.opts)).reason, 'complete')
    assert.equal(f.writes, 0)
    assert(!advertised[0].includes('write_file'))
    const result = f.history.view().find((message) => message.role === 'tool')
    assert.equal(result?.tool_call_id, 'write_file')
    assert.match(result!.content, /不在本轮允许列表/)
    const calls = f.history.view().find((message) => message.tool_calls)?.tool_calls
    assert.equal(calls?.[0].id, result?.tool_call_id)
  })
}

await check('混合工具批次正常执行允许的读工具，拒绝写工具且保持结果顺序', async () => {
  let round = 0
  const f = fixture({ protocol: 'openai', async *streamChat() {
    if (++round === 1) { yield call('read_file', 'read-1'); yield call('write_file', 'write-1'); yield call('read_file', 'read-2') }
    else yield { type: 'text', text: '完成' }
    yield { type: 'done' }
  } }, { mode: 'plan' })
  assert.equal((await finish(f.opts)).reason, 'complete')
  assert.equal(f.reads, 2)
  assert.equal(f.writes, 0)
  assert.deepEqual(f.history.view().filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['read-1', 'write-1', 'read-2'])
})

await check('被工具列表拒绝的调用不触发权限询问、Hook 拦截或执行', async () => {
  let effects = 0
  const hooks = new HookEngine([])
  hooks.intercept = async () => { effects++; return null }
  const registry = new ToolRegistry()
  registry.register({ name: 'write_file', description: '计数', parameters: { type: 'object' }, async execute() { effects++; return { success: true, output: '' } } })
  const result = await executeToolCall(call('write_file'), registry, {
    cwd: process.cwd(), hooks, ask: async () => { effects++; return 'once' },
    permission: { mode: 'permissive', engine: { match: () => { effects++; return null } } as never },
  }, undefined, new Set())
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /工具限制/)
  assert.equal(effects, 0)
})

await check('流处理中新增的工具本轮不得执行，下一轮声明后可以执行', async () => {
  let executions = 0
  let round = 0
  const advertised: string[][] = []
  const f = fixture({ protocol: 'openai', async *streamChat(_messages, opts) {
    advertised.push(opts.tools!.map((tool) => tool.function.name))
    if (++round === 1) {
      f.registry.register({ name: 'late_tool', description: '新增', parameters: { type: 'object' }, async execute() { executions++; return { success: true, output: '完成' } } })
      yield call('late_tool', 'late-1')
    } else if (round === 2) { assert.equal(executions, 0); yield call('late_tool', 'late-2') }
    else yield { type: 'text', text: '完成' }
    yield { type: 'done' }
  } })
  assert.equal((await finish(f.opts)).reason, 'complete')
  assert(!advertised[0].includes('late_tool'))
  assert(advertised[1].includes('late_tool'))
  assert.equal(executions, 1)
})

await check('动态指令和工具列表按轮刷新，并在上下文检查前计入请求预算', async () => {
  let round = 0
  let activated = false
  let overhead = 0
  const budgets: number[] = []
  const captured: Array<{ hasSkill: boolean; tools: ProviderTool[] }> = []
  const f = fixture({ protocol: 'openai', async *streamChat(messages, opts) {
    const tools = opts.tools!
    const hasSkill = messages.some((message) => message.content === 'S'.repeat(20000))
    captured.push({ hasSkill, tools })
    const expected = Math.ceil(JSON.stringify(tools).length / 4) + messages.filter((message) => message.role === 'system').reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    assert.equal(overhead, expected)
    assert.equal(budgets.at(-1), expected)
    if (++round === 1) yield call('activate')
    else yield { type: 'text', text: '完成' }
    yield { type: 'done' }
  } })
  f.registry.register({ name: 'activate', description: '激活', parameters: { type: 'object' }, async execute() { activated = true; return { success: true, output: '已激活' } } })
  f.opts.extraSystemMessages = ['静态指令']
  f.opts.resolveRequestOptions = () => ({
    toolsOverride: activated ? [{ type: 'function', function: { name: 'read_file', description: 'D'.repeat(10000), parameters: { type: 'object' } } }] : null,
    extraSystemMessages: activated ? ['S'.repeat(20000)] : [],
  })
  f.opts.ctx.setRequestOverhead = (tokens) => { overhead = tokens }
  f.opts.ctx.beforeRequest = async () => { budgets.push(overhead) }
  assert.equal((await finish(f.opts)).reason, 'complete')
  assert.equal(captured[0].hasSkill, false)
  assert.equal(captured[1].hasSkill, true)
  assert.deepEqual(captured[1].tools.map((tool) => tool.function.name), ['read_file'])
  assert(budgets[1] > budgets[0] + 5000)
})

console.log(`\nagent_tool_policy_test: ${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
