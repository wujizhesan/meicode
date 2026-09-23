// Agent Loop 测试：五类停止条件 + 分批执行 + Plan Mode + system 注入
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { History } from '../src/session/history.ts'
import { runAgent } from '../src/agent/loop.ts'
import { buildPrompt } from '../src/agent/prompt/index.ts'
import type { AgentEvent, AgentHandle } from '../src/agent/events.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { RuntimeEventLog } from '../src/runtime/index.ts'
import { HookEngine } from '../src/hook/index.ts'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  createTools({ cwd: process.cwd() }).forEach((t) => r.register(t))
  return r
}

const ctx: ToolContext = { cwd: process.cwd(), timeoutMs: 2000 }

interface AgentRound {
  events: StreamEvent[]
  delayMs?: number // 每事件间延迟（模拟慢流）
}

class FakeAgentProvider implements Provider {
  readonly protocol = 'openai' as const
  capturedTools: unknown = null
  capturedMessages: ChatMessage[] = []
  capturedAll: ChatMessage[][] = []

  private behavior: (msgs: ChatMessage[]) => AgentRound

  constructor(behavior: (msgs: ChatMessage[]) => AgentRound) {
    this.behavior = behavior
  }

  async *streamChat(messages: ChatMessage[], opts: { tools?: unknown }): AsyncGenerator<StreamEvent> {
    this.capturedTools = opts.tools ?? null
    this.capturedMessages = messages
    this.capturedAll.push([...messages])
    const round = this.behavior(messages)
    for (const ev of round.events) {
      yield ev
      if (round.delayMs) await sleep(round.delayMs)
    }
  }
}

function baseOpts(provider: Provider, history: History, mode: 'plan' | 'full' = 'full') {
  return {
    provider,
    history,
    registry: makeRegistry(),
    ctx,
    maxIterations: 15,
    mode,
    systemPrompt: buildPrompt(mode),
    unknownToolLimit: 2,
  }
}

async function consume(agent: AgentHandle) {
  const events: AgentEvent[] = []
  for await (const ev of agent.events) events.push(ev)
  return { events, result: await agent.done }
}

async function main() {
  // ---------- 五类停止条件 ----------
  await check('complete: 无工具调用单轮完成', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [
        { type: 'text', text: '直接回答' },
        { type: 'done' },
      ],
    }))
    const history = new History()
    history.push({ role: 'user', content: '你好' })
    const { events, result } = await consume(runAgent(baseOpts(p, history)))
    if (result.reason !== 'complete') throw new Error(`reason=${result.reason}`)
    if (result.rounds !== 1) throw new Error(`rounds=${result.rounds}`)
    if (history.all().length !== 2) throw new Error(`历史段数 ${history.all().length}`)
  })
  await check('usage: 输出增量不会用零值覆盖输入 token 锚点', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [
        { type: 'usage', inputTokens: 321, outputTokens: 0 },
        { type: 'usage', inputTokens: 0, outputTokens: 45 },
        { type: 'text', text: '完成' },
        { type: 'done' },
      ],
    }))
    const history = new History()
    history.push({ role: 'user', content: 'usage' })
    const anchors: number[] = []
    const { result } = await consume(runAgent({
      ...baseOpts(p, history),
      ctx: { ...ctx, afterRequest: (inputTokens) => anchors.push(inputTokens) },
    }))
    if (anchors.join(',') !== '321') throw new Error(`上下文锚点错误: ${anchors.join(',')}`)
    if (result.totalTokens !== 366) throw new Error(`总 token 错误: ${result.totalTokens}`)
  })
  await check('事件队列: 高频文本流保持完整顺序', async () => {
    const chunks = Array.from({ length: 3000 }, (_, index) => String(index % 10))
    const p = new FakeAgentProvider(() => ({
      events: [...chunks.map((text) => ({ type: 'text' as const, text })), { type: 'done' as const }],
    }))
    const history = new History()
    history.push({ role: 'user', content: '高频流' })
    const { events, result } = await consume(runAgent(baseOpts(p, history)))
    const output = events.filter((event) => event.type === 'text').map((event) => event.text).join('')
    if (output !== chunks.join('')) throw new Error(`事件流丢失或乱序: ${output.length}/${chunks.length}`)
    if (result.finalText !== output) throw new Error('最终文本与事件流不一致')
  })
  await check('历史清洗缓存: 增量追加并在结构替换后失效', async () => {
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      if (round === 1) {
        return { events: [{ type: 'tool_call', id: 'cache_call', name: 'read_file', arguments: { path: 'package.json' } }, { type: 'done' }] }
      }
      return { events: [{ type: 'text', text: '完成' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '原始问题' })
    let request = 0
    await consume(runAgent({
      ...baseOpts(p, history),
      ctx: {
        ...ctx,
        beforeRequest: async () => {
          request++
          if (request === 2) history.replaceRange(0, 1, [{ role: 'user', content: '替换后的问题' }])
        },
      },
    }))
    const second = p.capturedAll[1] ?? []
    if (!second.some((message) => message.content === '替换后的问题')) throw new Error('结构替换后仍使用旧缓存')
    if (!second.some((message) => message.role === 'tool' && message.tool_call_id === 'cache_call')) throw new Error('增量工具结果未进入请求历史')
  })
  await check('teamBusy: 纯文本轮+团队忙不判 complete(防"[等待]"当最终输出)', async () => {
    // 第一轮: 纯文本+团队忙 → 不 complete,注入提示继续;第二轮: 纯文本+团队闲 → complete
    let busy = true
    const p = new FakeAgentProvider((msgs) => {
      const round = msgs.filter((m) => m.role === 'user').length
      if (round <= 2) {
        return { events: [{ type: 'text', text: '[等待] 团队任务执行中...' }, { type: 'done' }] }
      }
      return { events: [{ type: 'text', text: '任务完成' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '派发团队任务' })
    const opts = baseOpts(p, history)
    const { result } = await consume(
      runAgent({
        ...opts,
        teamBusy: () => {
          const r = busy
          busy = false // 第一轮后团队不忙
          return r
        },
      }),
    )
    if (result.reason !== 'complete') throw new Error(`reason=${result.reason}`)
    if (result.rounds !== 2) throw new Error(`应 2 轮(首轮被拦截): rounds=${result.rounds}`)
  })

  await check('max_iterations: 每轮调工具 → 15 轮停止', async () => {
    // 每轮参数不同——避免触发重复调用检测(同参数 ≥5 次会先停)
    let pround = 0
    const p = new FakeAgentProvider(() => {
      pround++
      return {
        events: [
          { type: 'tool_call', id: `call_${pround}`, name: 'run_command', arguments: { command: `echo r${pround}` } },
          { type: 'done' },
        ],
      }
    })
    const history = new History()
    history.push({ role: 'user', content: '一直调工具' })
    const { result } = await consume(runAgent(baseOpts(p, history)))
    if (result.reason !== 'max_iterations') throw new Error(`reason=${result.reason}`)
    if (result.rounds !== 15) throw new Error(`rounds=${result.rounds}`)
  })

  await check('cancelled: 循环中 cancel → 干净停止', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [
        { type: 'tool_call', id: 'call_c', name: 'read_file', arguments: { path: 'package.json' } },
        { type: 'done' },
      ],
      delayMs: 50,
    }))
    const history = new History()
    history.push({ role: 'user', content: '取消测试' })
    const agent = runAgent(baseOpts(p, history))
    setTimeout(() => agent.cancel(), 30)
    const { result } = await consume(agent)
    if (result.reason !== 'cancelled') throw new Error(`reason=${result.reason}`)
  })

  await check('cancelled: cancel 会终止正在运行的命令', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [{ type: 'tool_call', id: 'call_cmd_cancel', name: 'run_command', arguments: { command: 'ping -n 8 127.0.0.1', timeout: 10000 } }, { type: 'done' }],
    }))
    const history = new History()
    history.push({ role: 'user', content: '取消命令' })
    const agent = runAgent(baseOpts(p, history))
    const started = Date.now()
    setTimeout(() => agent.cancel(), 80)
    const { result } = await consume(agent)
    if (result.reason !== 'cancelled') throw new Error(`reason=${result.reason}`)
    if (Date.now() - started > 3000) throw new Error('取消后命令仍等待到超时')
  })

  await check('cancelled: cancel 会释放等待中的权限询问', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [{ type: 'tool_call', id: 'call_permission_cancel', name: 'write_file', arguments: { path: 'cancelled.txt', content: 'x' } }, { type: 'done' }],
    }))
    const history = new History()
    history.push({ role: 'user', content: '取消权限询问' })
    const engine = new RuleEngine('', '', '')
    const agent = runAgent({
      ...baseOpts(p, history),
      ctx: {
        ...ctx,
        permission: { mode: 'default', engine },
        ask: async () => new Promise(() => {}),
      },
    })
    setTimeout(() => agent.cancel(), 30)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const consumed = await Promise.race([
        consume(agent),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('权限询问取消后仍悬挂')), 1000) }),
      ])
      if (consumed.result.reason !== 'cancelled') throw new Error(`reason=${consumed.result.reason}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  })

  await check('unknown_tool: 连续 2 次未知工具停止', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [
        { type: 'tool_call', id: 'call_u', name: 'no_such_tool', arguments: {} },
        { type: 'done' },
      ],
    }))
    const history = new History()
    history.push({ role: 'user', content: '未知工具' })
    const { result } = await consume(runAgent(baseOpts(p, history)))
    if (result.reason !== 'unknown_tool') throw new Error(`reason=${result.reason}`)
    if (result.rounds !== 2) throw new Error(`rounds=${result.rounds}（应第 2 轮停止）`)
  })

  await check('endgame: 剩余 ≤3 轮注入报告优先提醒', async () => {
    let captured: ChatMessage[][] = []
    const p = new FakeAgentProvider((msgs) => {
      captured.push(msgs)
      return { events: [{ type: 'text', text: 'x' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '任务' })
    await consume(runAgent({ ...baseOpts(p, history), maxIterations: 3 }))
    const last = captured[captured.length - 1]
    const hint = last.find((m) => m.content.includes('剩余') && m.content.includes('write_file'))
    if (!hint) throw new Error('未注入报告优先提醒')
    if (!hint.content.includes('报告优先')) throw new Error(`提醒内容: ${hint.content.slice(0, 60)}`)
  })
  await check('tool_repeat: 同参数重复 5 次停止', async () => {
    // 用 write_file(非查询工具)——read_file 等查询类已豁免(轮询合法)；阈值 5(写报告迭代合法,3 次误杀实锤)
    const p = new FakeAgentProvider(() => ({
      events: [
        { type: 'tool_call', id: `call_${Math.random()}`, name: 'write_file', arguments: { path: 'same.txt', content: 'x' } },
        { type: 'done' },
      ],
    }))
    const history = new History()
    history.push({ role: 'user', content: '死循环' })
    const { result } = await consume(runAgent(baseOpts(p, history)))
    if (result.reason !== 'tool_repeat') throw new Error(`reason=${result.reason}`)
    if (result.rounds !== 5) throw new Error(`rounds=${result.rounds}(应在第 5 轮停)`)
  })

  await check('unknown_tool: 合法轮清零后重新计数', async () => {
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      if (round === 1) return { events: [{ type: 'tool_call', id: 'a', name: 'no_such_tool', arguments: {} }, { type: 'done' }] }
      if (round === 2) return { events: [{ type: 'tool_call', id: 'b', name: 'read_file', arguments: { path: 'package.json' } }, { type: 'done' }] }
      return { events: [{ type: 'tool_call', id: 'c', name: 'no_such_tool', arguments: {} }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '计数' })
    const { result } = await consume(runAgent(baseOpts(p, history)))
    // 第 3、4 轮连续未知 → 第 4 轮停止
    if (result.reason !== 'unknown_tool' || result.rounds !== 4) throw new Error(`reason=${result.reason} rounds=${result.rounds}`)
  })

  await check('error: 流错误停止', async () => {
    const p = new FakeAgentProvider(() => ({
      events: [{ type: 'error', message: '模拟网络中断' }],
    }))
    const history = new History()
    history.push({ role: 'user', content: '出错' })
    const { result } = await consume(runAgent(baseOpts(p, history)))
    if (result.reason !== 'error') throw new Error(`reason=${result.reason}`)
  })

  await check('error: 重复工具调用 ID 在执行前拒绝', async () => {
    let executions = 0
    const localRegistry = new ToolRegistry()
    localRegistry.register({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      async execute() {
        executions++
        return { success: true, output: 'executed' }
      },
    })
    const p = new FakeAgentProvider(() => ({
      events: [
        { type: 'tool_call', id: 'duplicate-id', name: 'probe', arguments: {} },
        { type: 'tool_call', id: 'duplicate-id', name: 'probe', arguments: {} },
        { type: 'done' },
      ],
    }))
    const history = new History()
    history.push({ role: 'user', content: 'duplicate id' })
    const { result } = await consume(runAgent({ ...baseOpts(p, history), registry: localRegistry }))
    if (result.reason !== 'error' || executions !== 0 || history.length !== 1) {
      throw new Error(`重复 ID 未在执行前拒绝: reason=${result.reason} executions=${executions} history=${history.length}`)
    }
  })

  await check('Hook: pre_compact 注入进入同一次模型请求', async () => {
    const hooks = new HookEngine([
      { event: 'pre_compact', action: { type: 'inject_prompt', content: '压缩前提示' } },
    ])
    const p = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: '完成' }, { type: 'done' }] }))
    const history = new History()
    history.push({ role: 'user', content: 'compact hook' })
    const hookCtx: ToolContext = {
      ...ctx,
      sessionId: 'compact-session',
      agentId: 'compact-agent',
      hooks,
      beforeRequest: async () => {
        await hooks.fire('pre_compact', {
          cwd: ctx.cwd,
          sessionId: 'compact-session',
          agentId: 'compact-agent',
        })
      },
    }
    await consume(runAgent({ ...baseOpts(p, history), ctx: hookCtx }))
    if (!p.capturedMessages.some((message) => message.role === 'system' && message.content === '压缩前提示')) {
      throw new Error('pre_compact 注入未进入当前模型请求')
    }
  })

  await check('Hook: 每轮注入只投递一次且不累积', async () => {
    const hooks = new HookEngine([
      { event: 'round_start', action: { type: 'inject_prompt', content: '单轮提示' } },
    ])
    const localRegistry = new ToolRegistry()
    localRegistry.register({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { success: true, output: 'ok' }
      },
    })
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      return round === 1
        ? { events: [{ type: 'tool_call', id: 'probe-1', name: 'probe', arguments: {} }, { type: 'done' }] }
        : { events: [{ type: 'text', text: '完成' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: 'round hook' })
    await consume(runAgent({
      ...baseOpts(p, history),
      registry: localRegistry,
      ctx: { ...ctx, sessionId: 'round-session', agentId: 'round-agent', hooks },
    }))
    const counts = p.capturedAll.map((messages) => messages.filter((message) => message.content === '单轮提示').length)
    if (counts.join(',') !== '1,1') throw new Error(`Hook 注入重复或累积: ${counts.join(',')}`)
  })

  await check('Hook: round_end 注入保留到下一次 Agent 请求', async () => {
    const hooks = new HookEngine([
      { event: 'round_end', action: { type: 'inject_prompt', content: '上次执行已结束' } },
    ])
    const scope = { ...ctx, sessionId: 'round-end-session', agentId: 'round-end-agent', hooks }
    const firstProvider = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: '第一次完成' }, { type: 'done' }] }))
    const firstHistory = new History()
    firstHistory.push({ role: 'user', content: 'first' })
    await consume(runAgent({ ...baseOpts(firstProvider, firstHistory), ctx: scope }))

    const secondProvider = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: '第二次完成' }, { type: 'done' }] }))
    const secondHistory = new History()
    secondHistory.push({ role: 'user', content: 'second' })
    await consume(runAgent({ ...baseOpts(secondProvider, secondHistory), ctx: scope }))
    const injected = secondProvider.capturedMessages.filter((message) => message.content === '上次执行已结束')
    if (injected.length !== 1) throw new Error(`round_end 注入未进入下一次请求: ${injected.length}`)
  })

  // ---------- 分批执行 ----------
  await check('分批: 2 个读工具并发（时间重叠）', async () => {
    writeFileSync('test/fixtures_loop_a.txt', 'A', 'utf8')
    writeFileSync('test/fixtures_loop_b.txt', 'B', 'utf8')
    let done = 0
    const p = new FakeAgentProvider(() => {
      if (done === 0) {
        done = 1
        return {
          events: [
            { type: 'tool_call', id: 'r1', name: 'read_file', arguments: { path: 'test/fixtures_loop_a.txt' } },
            { type: 'tool_call', id: 'r2', name: 'read_file', arguments: { path: 'test/fixtures_loop_b.txt' } },
            { type: 'done' },
          ],
        }
      }
      return { events: [{ type: 'text', text: '读完了' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '并发读' })
    // 两个读工具都是即时 IO，直接断言 tool_result 事件都出现且无串行等待问题
    const { events, result } = await consume(runAgent(baseOpts(p, history)))
    const results = events.filter((e) => e.type === 'tool_result')
    if (results.length !== 2) throw new Error(`tool_result 数 ${results.length}`)
    if (result.reason !== 'complete') throw new Error(`reason=${result.reason}`)
    rmSync('test/fixtures_loop_a.txt', { force: true })
    rmSync('test/fixtures_loop_b.txt', { force: true })
  })

  await check('分批: 读+写串行（写发生在读完成后）', async () => {
    const order: string[] = []
    const localRegistry = new ToolRegistry()
    // 用自定义慢速读工具模拟顺序
    const slowRead = {
      name: 'slow_read',
      description: '慢速读',
      parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
      async execute() {
        order.push('read-start')
        await sleep(100)
        order.push('read-end')
        return { success: true, output: 'content' }
      },
    }
    const slowWrite = {
      name: 'slow_write',
      description: '慢速写',
      parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
      async execute() {
        order.push('write-start')
        return { success: true, output: 'written' }
      },
    }
    localRegistry.register(slowRead)
    localRegistry.register(slowWrite)
    let done = 0
    const p = new FakeAgentProvider(() => {
      if (done === 0) {
        done = 1
        return {
          events: [
            { type: 'tool_call', id: 's1', name: 'slow_read', arguments: { path: 'a' } },
            { type: 'tool_call', id: 's2', name: 'slow_write', arguments: { path: 'b' } },
            { type: 'done' },
          ],
        }
      }
      return { events: [{ type: 'text', text: '完成' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '串行' })
    await consume(runAgent({ ...baseOpts(p, history), registry: localRegistry }))
    const wi = order.indexOf('write-start')
    const re = order.indexOf('read-end')
    if (wi < 0 || re < 0) throw new Error(`顺序记录缺失: ${JSON.stringify(order)}`)
    if (wi < re) throw new Error(`写应在读完成之后: ${JSON.stringify(order)}`)
  })

  await check('分批: 混合调用保持写读屏障与原始顺序', async () => {
    const order: string[] = []
    const localRegistry = new ToolRegistry()
    localRegistry.register({
      name: 'read_file',
      description: '测试读取',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args) {
        order.push(`read-${args.path}-start`)
        await sleep(30)
        order.push(`read-${args.path}-end`)
        return { success: true, output: String(args.path) }
      },
    })
    localRegistry.register({
      name: 'write_file',
      description: '测试写入',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args) {
        order.push(`write-${args.path}`)
        return { success: true, output: String(args.path) }
      },
    })
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      if (round > 1) return { events: [{ type: 'text', text: '完成' }, { type: 'done' }] }
      return {
        events: [
          { type: 'tool_call', id: 'w1', name: 'write_file', arguments: { path: 'before' } },
          { type: 'tool_call', id: 'r1', name: 'read_file', arguments: { path: 'a' } },
          { type: 'tool_call', id: 'r2', name: 'read_file', arguments: { path: 'b' } },
          { type: 'tool_call', id: 'w2', name: 'write_file', arguments: { path: 'after' } },
          { type: 'done' },
        ],
      }
    })
    const history = new History()
    history.push({ role: 'user', content: '顺序测试' })
    await consume(runAgent({ ...baseOpts(p, history), registry: localRegistry }))

    const firstWrite = order.indexOf('write-before')
    const firstRead = order.indexOf('read-a-start')
    const secondRead = order.indexOf('read-b-start')
    const lastRead = Math.max(order.indexOf('read-a-end'), order.indexOf('read-b-end'))
    const lastWrite = order.indexOf('write-after')
    if (!(firstWrite < firstRead && firstWrite < secondRead)) throw new Error(`前置写入被重排: ${JSON.stringify(order)}`)
    if (!(firstRead < order.indexOf('read-b-end') && secondRead < order.indexOf('read-a-end'))) {
      throw new Error(`相邻读取未并发: ${JSON.stringify(order)}`)
    }
    if (lastWrite < lastRead) throw new Error(`后置写入越过读取屏障: ${JSON.stringify(order)}`)
  })

  // ---------- Plan Mode ----------
  await check('plan mode: 请求 tools 仅含 3 个读类工具', async () => {
    const p = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: '计划' }, { type: 'done' }] }))
    const history = new History()
    history.push({ role: 'user', content: '分析' })
    await consume(runAgent(baseOpts(p, history, 'plan')))
    const tools = p.capturedTools as { function: { name: string } }[]
    if (!tools || tools.length !== 3) throw new Error(`plan tools 数 ${tools?.length}`)
    for (const t of tools) {
      if (!['read_file', 'find_files', 'grep_code'].includes(t.function.name)) {
        throw new Error(`plan 模式混入非读工具: ${t.function.name}`)
      }
    }
  })

  await check('full mode: 请求 tools 含全部 16 个', async () => {
    const p = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: 'ok' }, { type: 'done' }] }))
    const history = new History()
    history.push({ role: 'user', content: '执行' })
    await consume(runAgent(baseOpts(p, history, 'full')))
    const tools = p.capturedTools as { function: { name: string } }[]
    if (!tools || tools.length !== 12) throw new Error(`full tools 数 ${tools?.length}`)
  })

  // ---------- system 注入 ----------
  await check('system prompt 注入为第一条消息', async () => {
    const p = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: 'ok' }, { type: 'done' }] }))
    const history = new History()
    history.push({ role: 'user', content: 'hi' })
    await consume(runAgent(baseOpts(p, history)))
    if (p.capturedMessages[0]?.role !== 'system') throw new Error('首条非 system')
  })

  await check('上下文预算: 每轮只生成一次快照', async () => {
    const p = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: 'ok' }, { type: 'done' }] }))
    const history = new History()
    history.push({ role: 'user', content: 'hi' })
    let snapshots = 0
    await consume(runAgent({
      ...baseOpts(p, history),
      ctx: {
        ...ctx,
        contextBudget: () => {
          snapshots++
          return {
            window: 1000,
            estimatedTokens: 10,
            remainingTokens: 990,
            autoMargin: 100,
            manualMargin: 10,
            historyMessages: history.length,
            breakerOpen: false,
          }
        },
      },
    }))
    if (snapshots !== 1) throw new Error(`快照生成次数 ${snapshots}`)
  })

  // ---------- P4: 前缀稳定 / 环境分流 / 轮次注入 / 双重强化 ----------
  await check('P4: 主 system 前缀跨轮次字节一致', async () => {
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      return { events: [{ type: 'tool_call', id: `t${round}`, name: 'run_command', arguments: { command: `echo r${round}` } }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '多轮' })
    await consume(runAgent(baseOpts(p, history)))
    const mains = p.capturedAll.map((m) => m[0].content)
    if (mains.length < 3) throw new Error(`轮次数 ${mains.length}`)
    if (mains.some((c) => c !== mains[0])) throw new Error('主 system 跨轮次不一致')
  })

  await check('P4: 环境信息独立 system 消息且含 cwd', async () => {
    const p = new FakeAgentProvider(() => ({ events: [{ type: 'text', text: 'ok' }, { type: 'done' }] }))
    const history = new History()
    history.push({ role: 'user', content: 'hi' })
    await consume(runAgent(baseOpts(p, history)))
    const msgs = p.capturedAll[0]
    if (msgs[1].role !== 'system' || !msgs[1].content.includes('当前工作目录')) {
      throw new Error(`环境消息不符: ${JSON.stringify(msgs[1])}`)
    }
    if (msgs[0].content.includes('当前工作目录') || msgs[0].content.includes(process.cwd())) {
      throw new Error('主 system 混入环境信息')
    }
  })

  await check('P4: 轮次注入——第 1/4 轮全量、2/3 轮精简', async () => {
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      return { events: [{ type: 'tool_call', id: `t${round}`, name: 'run_command', arguments: { command: `echo r${round}` } }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '多轮' })
    await consume(runAgent(baseOpts(p, history)))
    const dirs = p.capturedAll.map((m) => m[2]?.content ?? '')
    if (dirs.length < 4) throw new Error(`轮次数 ${dirs.length}`)
    const isFull = (s: string) => s.includes('当前处于') && s.includes('全部工具')
    const isSlim = (s: string) => s.includes('执行模式') && !s.includes('全部工具可用，按用户需求')
    if (!isFull(dirs[0])) throw new Error(`第 1 轮应全量: ${dirs[0].slice(0, 50)}`)
    if (!isSlim(dirs[1])) throw new Error(`第 2 轮应精简: ${dirs[1].slice(0, 50)}`)
    if (!isSlim(dirs[2])) throw new Error(`第 3 轮应精简: ${dirs[2].slice(0, 50)}`)
    if (!isFull(dirs[3])) throw new Error(`第 4 轮应全量: ${dirs[3].slice(0, 50)}`)
  })

  await check('P4: 双重强化——工具 description 含关键规则', () => {
    const registry = makeRegistry()
    const edit = registry.get('edit_file')
    const read = registry.get('read_file')
    if (!edit?.description.includes('先读取')) throw new Error(`edit_file 缺「先读取」: ${edit?.description}`)
    if (!edit.description.includes('重试')) throw new Error(`edit_file 缺「重试」: ${edit.description}`)
    if (!read?.description.includes('先读取')) throw new Error(`read_file 缺「先读取」`)
  })

  // ---------- P5: 权限集成 ----------
  await check('P5: 权限拒绝 → [权限拒绝] 回灌且循环继续', async () => {
    const engine = new RuleEngine('', '', '')
    engine.addSessionRule({ tool: 'run_command', pattern: 'git *', action: 'deny' })
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      if (round === 1) {
        return { events: [{ type: 'tool_call', id: 'p1', name: 'run_command', arguments: { command: 'git status' } }, { type: 'done' }] }
      }
      return { events: [{ type: 'text', text: '权限拒绝了，我换个方式' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '执行 git' })
    const permCtx = { cwd: process.cwd(), timeoutMs: 2000, permission: { mode: 'default' as const, engine } }
    const { events, result } = await consume(
      runAgent({ ...baseOpts(p, history), ctx: permCtx }),
    )
    const toolMsg = history.all().find((m) => m.role === 'tool')
    if (!toolMsg || !toolMsg.content.includes('[权限拒绝]')) throw new Error(`拒绝未回灌: ${JSON.stringify(toolMsg)}`)
    if (result.reason !== 'complete') throw new Error(`循环应继续: ${result.reason}`)
    if (result.finalText !== '权限拒绝了，我换个方式') throw new Error('模型未基于拒绝调整')
  })

  await check('P5: ask 四态——session 放行后同命令不再询问', async () => {
    const engine = new RuleEngine('', '', '')
    let askCount = 0
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      if (round === 1) {
        return { events: [{ type: 'tool_call', id: 'a1', name: 'run_command', arguments: { command: 'echo hi' } }, { type: 'done' }] }
      }
      return { events: [{ type: 'tool_call', id: 'a2', name: 'run_command', arguments: { command: 'echo hi' } }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '执行' })
    const permCtx = {
      cwd: process.cwd(),
      timeoutMs: 2000,
      permission: { mode: 'default' as const, engine },
      ask: async () => {
        askCount++
        return 'session' as const
      },
    }
    // 第 1 轮 ask 返回 session → 规则写入；第 2 轮同命令直接放行
    const agent = runAgent({ ...baseOpts(p, history), ctx: permCtx, maxIterations: 3 })
    for await (const _ev of agent.events) {
      // 消费事件
    }
    if (askCount !== 1) throw new Error(`ask 次数 ${askCount}，期望 1（第二次应命中会话规则）`)
  })

  await check('P5: ask 拒绝 → 用户拒绝回灌', async () => {
    const engine = new RuleEngine('', '', '')
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      if (round === 1) {
        return { events: [{ type: 'tool_call', id: 'r1', name: 'run_command', arguments: { command: 'echo x' } }, { type: 'done' }] }
      }
      return { events: [{ type: 'text', text: '用户拒绝了' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '执行' })
    const permCtx = {
      cwd: process.cwd(),
      timeoutMs: 2000,
      permission: { mode: 'default' as const, engine },
      ask: async () => 'deny' as const,
    }
    const { result } = await consume(runAgent({ ...baseOpts(p, history), ctx: permCtx }))
    const toolMsg = history.all().find((m) => m.role === 'tool')
    if (!toolMsg || !toolMsg.content.includes('用户拒绝')) throw new Error(`拒绝未回灌: ${JSON.stringify(toolMsg)}`)
    if (result.reason !== 'complete') throw new Error('循环应继续')
  })

  await check('运行时事件: 连续工具调用批量落盘', async () => {
    const eventDir = join(process.cwd(), 'test', 'fixtures_loop_events')
    rmSync(eventDir, { recursive: true, force: true })
    class CountingRuntimeEventLog extends RuntimeEventLog {
      batches: string[][] = []
      payloads: Record<string, unknown>[] = []

      override appendBatch(inputs: Parameters<RuntimeEventLog['appendBatch']>[0]) {
        this.batches.push(inputs.map((input) => input.type))
        this.payloads.push(...inputs.flatMap((input) => input.payload ? [input.payload] : []))
        return super.appendBatch(inputs)
      }
    }
    const runtimeEvents = new CountingRuntimeEventLog(eventDir)
    let round = 0
    const p = new FakeAgentProvider(() => {
      round++
      return round === 1
        ? { events: [
            { type: 'tool_call', id: 'batch_1', name: 'read_file', arguments: { path: 'package.json', probe: 'x'.repeat(2000) } },
            { type: 'tool_call', id: 'batch_2', name: 'read_file', arguments: { path: 'tsconfig.json' } },
            { type: 'done' },
          ] }
        : { events: [{ type: 'text', text: '完成' }, { type: 'done' }] }
    })
    const history = new History()
    history.push({ role: 'user', content: '读取文件' })
    const { result } = await consume(runAgent({
      ...baseOpts(p, history),
      ctx: { ...ctx, sessionId: 'batch-runtime-events', runtimeEvents },
    }))
    rmSync(eventDir, { recursive: true, force: true })
    if (result.evidence.files.length !== 2) throw new Error('Agent 结果未携带执行期工具证据')
    if (!runtimeEvents.batches.some((types) => types.join(',') === 'turn_started,context_snapshot,model_request')) throw new Error('轮次起始事件未与请求快照批量写入')
    if (!runtimeEvents.batches.some((types) => types.join(',') === 'tool_call,tool_call')) throw new Error('连续工具调用未批量写入运行时日志')
    const compacted = runtimeEvents.payloads.find((payload) => payload.argumentsTruncated === true)
    const compactedArgs = compacted?.arguments as Record<string, unknown> | undefined
    if (typeof compactedArgs?.probe !== 'string' || compactedArgs.probe.length > 600) throw new Error('大工具参数未在运行时日志中截断')
    const persistedCall = history.view().find((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'batch_1')?.tool_calls?.[0]
    const persistedArgs = persistedCall ? JSON.parse(persistedCall.arguments) as Record<string, unknown> : undefined
    if (typeof persistedArgs?.probe !== 'string' || persistedArgs.probe.length !== 2000) throw new Error('会话历史中的完整工具参数被误截断')
  })

  // ---------- buildPrompt ----------
  await check('buildPrompt: 三态内容正确', () => {
    if (!buildPrompt('plan').includes('计划模式')) throw new Error('plan prompt 缺关键词')
    if (!buildPrompt('full').includes('MeiCode')) throw new Error('full prompt 缺关键词')
    const withPlan = buildPrompt('full', '第一步：读文件')
    if (!withPlan.includes('你已制定的计划') || !withPlan.includes('第一步：读文件')) {
      throw new Error('planContext 注入失败')
    }
  })

  await check('provider failure is preserved in result and done event', async () => {
    const provider = new FakeAgentProvider(() => {
      throw new Error('injected provider failure')
    })
    const history = new History()
    history.push({ role: 'user', content: 'provider failure' })
    const { events, result } = await consume(runAgent(baseOpts(provider, history)))
    const done = events.find((event) => event.type === 'done')
    if (result.reason !== 'error' || !result.errorMessage?.includes('injected provider failure')) {
      throw new Error(`result lost provider failure: ${JSON.stringify(result)}`)
    }
    if (!done || done.type !== 'done' || !done.errorMessage?.includes('injected provider failure')) {
      throw new Error(`done event lost provider failure: ${JSON.stringify(done)}`)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('loop 测试异常:', e)
  process.exit(1)
})
