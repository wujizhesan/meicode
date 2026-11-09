// 上下文管理测试：估算/存盘/摘要/触发/熔断/保留
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { History } from '../src/session/history.ts'
import { HookEngine } from '../src/hook/engine.ts'
import { createSessionActions } from '../src/tui/session-actions.ts'
import {
  TokenEstimator,
  spillBatch,
  tailKeep,
  summarize,
  summaryMessage,
  boundaryMessage,
  ContextManager,
  SPILL_THRESHOLD,
} from '../src/context/index.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'

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

const TMP = join(import.meta.dirname, 'fixtures_ctx')
mkdirSync(TMP, { recursive: true })

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function toolGroup(prefix: string, count: number): ChatMessage[] {
  const calls = Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, name: 'read_file', arguments: '{}' }))
  return [
    { role: 'assistant', content: '', tool_calls: calls },
    ...[...calls].reverse().map((call): ChatMessage => ({ role: 'tool', tool_call_id: call.id, content: `result-${call.id}: ${'x'.repeat(400)}` })),
  ]
}

function assertToolPairs(messages: readonly ChatMessage[]): void {
  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error('工具结果缺少配对调用')
    } else {
      if (pending.size > 0) throw new Error('工具调用结果不完整或不紧邻')
      if (message.role === 'assistant' && message.tool_calls?.length) {
        pending = new Set(message.tool_calls.map((call) => call.id))
        if (pending.size !== message.tool_calls.length) throw new Error('工具调用 ID 重复')
      }
    }
  }
  if (pending.size > 0) throw new Error('工具调用缺少结果')
}

// fake provider：可配置行为，捕获请求参数
class FakeCtxProvider implements Provider {
  readonly protocol = 'openai' as const
  capturedTools: unknown = null
  capturedMessages: ChatMessage[] = []
  failSummaries = false
  private behavior: (msgs: ChatMessage[]) => StreamEvent[]

  constructor(behavior?: (msgs: ChatMessage[]) => StreamEvent[]) {
    this.behavior = behavior ?? (() => [{ type: 'text', text: '这是摘要内容' }, { type: 'done' }])
  }

  async *streamChat(messages: ChatMessage[], opts: { tools?: unknown }): AsyncGenerator<StreamEvent> {
    this.capturedMessages = messages
    this.capturedTools = opts.tools ?? null
    if (this.failSummaries) {
      yield { type: 'error', message: '模拟摘要失败' }
      return
    }
    for (const ev of this.behavior(messages)) yield ev
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待摘要请求超时')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

class DeferredCtxProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly started = deferred()
  private gate = deferred()
  requests = 0
  events: StreamEvent[] = [{ type: 'text', text: '并发摘要' }]

  release(): void {
    this.gate.resolve()
  }

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.requests++
    this.started.resolve()
    await this.gate.promise
    for (const event of this.events) yield event
  }
}

function largeHistory(): History {
  const history = new History()
  for (let index = 0; index < 40; index++) {
    history.push(msg(index % 2 === 0 ? 'user' : 'assistant', `MESSAGE_${index}:` + 'x'.repeat(500)))
  }
  return history
}

async function main() {
  // ---------- 估算 ----------
  await check('估算: 锚点后增量字符/4', () => {
    const est = new TokenEstimator()
    const msgs = [msg('user', 'a'.repeat(400))]
    est.update(1000, msgs.length)
    const next = [...msgs, msg('assistant', 'b'.repeat(400))]
    const total = est.estimate(next)
    if (total !== 1000 + 100) throw new Error(`估算 ${total}，期望 1100`)
  })
  await check('估算: 无锚点全量估算', () => {
    const est = new TokenEstimator()
    const total = est.estimate([msg('user', 'x'.repeat(800))])
    if (total !== 200) throw new Error(`估算 ${total}，期望 200`)
  })

  // ---------- 存盘 ----------
  await check('存盘: 超阈值单条 → [已存盘]+预览+路径', async () => {
    const big = '大'.repeat(SPILL_THRESHOLD + 100)
    const [spilled] = await spillBatch([{ content: big }], TMP)
    if (!spilled.content.includes('[已存盘]')) throw new Error('缺 [已存盘] 标记')
    if (!spilled.content.includes('完整内容:')) throw new Error('缺路径')
    const rel = spilled.content.split('完整内容: ')[1]
    const abs = join(TMP, rel)
    if (!existsSync(abs)) throw new Error('存盘文件不存在')
    if (readFileSync(abs, 'utf8') !== big) throw new Error('存盘内容不完整')
  })
  await check('存盘: 批次合计超限挑大存', async () => {
    const small = 's'.repeat(1000)
    const big = 'B'.repeat(SPILL_THRESHOLD + 100)
    const [r1, r2] = await spillBatch([{ content: small }, { content: big }], TMP)
    if (!r2.content.includes('[已存盘]')) throw new Error('大的（第二个）应被存盘')
    if (r1.content.includes('[已存盘]')) throw new Error('小的不应被存盘')
  })
  await check('存盘: 小内容不触发', async () => {
    const [r] = await spillBatch([{ content: 'tiny' }], TMP)
    if (r.content !== 'tiny') throw new Error('小内容不应被处理')
  })
  await check('存盘: 同毫秒的并发批次独立存盘且不覆盖旧文件', async () => {
    const cwd = join(TMP, 'spill-concurrent')
    const dir = join(cwd, '.meicode', 'artifacts')
    mkdirSync(dir, { recursive: true })
    const timestamp = Date.now()
    const existing = join(dir, `spill_${timestamp}_0.txt`)
    writeFileSync(existing, 'OLD_RESULT', 'utf8')
    const contents = Array.from({ length: 16 }, (_, index) => `RESULT_${index}\n${'x'.repeat(SPILL_THRESHOLD + 1)}`)
    const now = Date.now
    Date.now = () => timestamp
    let results: PromiseSettledResult<{ content: string }[]>[]
    try {
      results = await Promise.allSettled(contents.map((content) => spillBatch([{ content }], cwd)))
    } finally {
      Date.now = now
    }
    const paths = results.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason
      return result.value[0].content.split('完整内容: ')[1]
    })
    if (new Set(paths).size !== contents.length) throw new Error('并发批次返回了相同的存盘路径')
    for (let index = 0; index < paths.length; index++) {
      if (!paths[index] || readFileSync(join(cwd, paths[index]), 'utf8') !== contents[index]) {
        throw new Error(`存盘内容与结果不对应: ${index}`)
      }
    }
    if (readFileSync(existing, 'utf8') !== 'OLD_RESULT') throw new Error('覆盖了已有存盘文件')
  })

  // ---------- tailKeep ----------
  await check('tailKeep: 尾部至少 5 条保留（minCount 兜底）', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 8; i++) msgs.push(msg('user', 'x'.repeat(8000))) // 每条 2000 token
    const { keep, drop } = tailKeep(msgs, 10000, 5)
    if (keep.length !== 5) throw new Error(`keep ${keep.length}，期望 5（minCount 兜底）`)
    if (drop.length !== 3) throw new Error(`drop ${drop.length}，期望 3`)
    if (keep[0].content !== msgs[3].content) throw new Error(`保留内容错: 应从第 4 条起`)
  })
  await check('tailKeep: token 阈值截断', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 8; i++) msgs.push(msg('user', 'x'.repeat(2000))) // 每条 500 token
    const { keep } = tailKeep(msgs, 1000, 5)
    // 1000 token ≈ 2 条，但 minCount 5 → 保留 5 条
    if (keep.length !== 5) throw new Error(`keep ${keep.length}，期望 5（minCount 兜底）`)
  })
  await check('tailKeep: token 切分保留完整并行工具组', () => {
    const group = toolGroup('parallel', 5)
    const messages = [msg('user', '早期背景'.repeat(3000)), ...group]
    const { keep, drop } = tailKeep(messages, 100, 5)
    if (keep.length !== group.length || drop.length !== 1 || keep[0] !== group[0]) {
      throw new Error('工具调用与五个结果被拆开')
    }
    assertToolPairs(keep)
    assertToolPairs(drop)
  })
  await check('tailKeep: 所有切分位置均不拆开单个或并行工具组', () => {
    const messages = [
      msg('user', '背景'), ...toolGroup('single', 1), msg('assistant', '第一轮结束'),
      msg('user', '继续'), ...toolGroup('parallel', 5), msg('assistant', '第二轮结束'), msg('user', '下一步'),
    ]
    for (let minCount = 1; minCount <= messages.length; minCount++) {
      const { keep, drop } = tailKeep(messages, 0, minCount)
      assertToolPairs(keep)
      assertToolPairs(drop)
      if (keep.length < minCount || JSON.stringify([...drop, ...keep]) !== JSON.stringify(messages)) {
        throw new Error(`保留数量不足或丢失、重排消息: ${minCount}`)
      }
    }
    const empty = tailKeep([], 100, 5)
    if (empty.keep.length || empty.drop.length) throw new Error('空历史处理异常')
  })

  // ---------- summarize ----------
  await check('摘要: 请求无 tools 参数', async () => {
    const p = new FakeCtxProvider()
    const text = await summarize(p, [msg('user', '早期内容')], { cwd: TMP })
    if (text !== '这是摘要内容') throw new Error(`摘要文本 ${text}`)
    if (p.capturedTools !== null) throw new Error('摘要请求带了 tools')
    if (p.capturedMessages[0]?.role !== 'system') throw new Error('摘要请求缺 system 提示')
  })
  await check('摘要: 失败抛错', async () => {
    const p = new FakeCtxProvider()
    p.failSummaries = true
    let threw = false
    try {
      await summarize(p, [msg('user', 'x')], { cwd: TMP })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('应抛错')
  })

  // ---------- manager ----------
  await check('manager: 小窗口触发摘要 + 边界消息 + 用户消息保留', async () => {
    const p = new FakeCtxProvider()
    const history = new History()
    // 构造大历史（无锚点 → 全量估算）
    for (let i = 0; i < 20; i++) {
      history.push(msg('user', `用户问题${i}` + 'x'.repeat(500)))
      history.push(msg('assistant', `回答${i}` + 'y'.repeat(300)))
    }
    const manager = new ContextManager({ provider: p, history, cwd: TMP, window: 3000, autoMargin: 1000 })
    await manager.beforeRequest('auto')
    const all = history.all()
    // 被保留的 user 消息必须原文存在（不被摘要改写）
    const keptUser = all.find((m) => m.role === 'user' && m.content.startsWith('用户问题'))
    if (!keptUser) throw new Error('保留的用户消息被改写')
    const summary = all.find((m) => m.content.includes('早期对话摘要'))
    if (!summary) throw new Error('摘要消息缺失')
    const boundary = all.find((m) => m.content.includes('部分早期对话已摘要'))
    if (!boundary) throw new Error('边界消息缺失')
  })
  await check('manager: 完整工具组可摘要且保留近期结果，不触发熔断', async () => {
    let requests = 0
    const provider = new FakeCtxProvider((messages) => {
      requests++
      assertToolPairs(messages)
      return [{ type: 'text', text: '合法摘要' }, { type: 'done' }]
    })
    const history = new History()
    const oldGroup = toolGroup('old', 1)
    const recentGroup = toolGroup('recent', 5)
    history.push(msg('user', '任务背景'.repeat(3000)))
    for (const message of [...oldGroup, ...recentGroup]) history.push(message)
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 1000, autoMargin: 100 })
    for (let index = 0; index < 3; index++) await manager.beforeRequest('auto')
    if (requests !== 1 || manager.breakerOpenState || manager.lastSummary !== '合法摘要') {
      throw new Error(`压缩失败、重复请求或触发熔断: ${requests}`)
    }
    assertToolPairs(provider.capturedMessages)
    if (!oldGroup.every((message) => provider.capturedMessages.includes(message))) throw new Error('旧工具组未完整进入摘要')
    const remaining = history.view()
    assertToolPairs(remaining)
    if (JSON.stringify(remaining.slice(2)) !== JSON.stringify(recentGroup)
      || !remaining[0]?.content.includes('早期对话摘要') || !remaining[1]?.content.includes('部分早期对话已摘要')) {
      throw new Error('压缩后丢失近期工具组或摘要边界')
    }
  })
  await check('manager: 熔断——失败 3 次停自动，manual 绕过', async () => {
    const p = new FakeCtxProvider()
    p.failSummaries = true
    const history = new History()
    for (let i = 0; i < 20; i++) {
      history.push(msg('user', `u${i}` + 'x'.repeat(500)))
      history.push(msg('assistant', `a${i}`))
    }
    const manager = new ContextManager({ provider: p, history, cwd: TMP, window: 3000, autoMargin: 1000, manualMargin: 1000 })
    await manager.beforeRequest('auto') // 1
    await manager.beforeRequest('auto') // 2
    await manager.beforeRequest('auto') // 3 → 熔断
    if (!manager.breakerOpenState) throw new Error('熔断未开启')
    const before = history.all().length
    await manager.beforeRequest('auto') // 熔断后不再尝试（无变化）
    if (history.all().length !== before) throw new Error('熔断后仍尝试摘要')
    p.failSummaries = false
    await manager.beforeRequest('manual')
    if (manager.breakerOpenState) throw new Error('手动摘要成功后自动熔断未复位')
  })
  await check('manager: 成功清零熔断计数', async () => {
    const p = new FakeCtxProvider()
    const history = new History()
    for (let i = 0; i < 20; i++) {
      history.push(msg('user', `u${i}` + 'x'.repeat(500)))
      history.push(msg('assistant', `a${i}`))
    }
    const manager = new ContextManager({ provider: p, history, cwd: TMP, window: 3000, autoMargin: 1000 })
    p.failSummaries = true
    await manager.beforeRequest('auto')
    await manager.beforeRequest('auto')
    p.failSummaries = false
    await manager.beforeRequest('auto') // 成功 → 清零
    if (manager.breakerOpenState) throw new Error('成功后不应熔断')
  })
  await check('manager: 未达上限不触发', async () => {
    const p = new FakeCtxProvider()
    const history = new History()
    history.push(msg('user', '你好'))
    const manager = new ContextManager({ provider: p, history, cwd: TMP, window: 131072 })
    await manager.beforeRequest('auto')
    const all = history.all()
    if (all.some((m) => m.content.includes('早期对话摘要'))) throw new Error('不应触发摘要')
  })
  await check('manager: 快照随历史版本失效', () => {
    const history = new History()
    const manager = new ContextManager({ provider: new FakeCtxProvider(), history, cwd: TMP, window: 131072 })
    history.push(msg('user', 'a'.repeat(40)))
    const first = manager.snapshot().estimatedTokens
    history.push(msg('assistant', 'b'.repeat(80)))
    const second = manager.snapshot().estimatedTokens
    if (first !== 10 || second !== 30) throw new Error(`缓存未失效: ${first} → ${second}`)
  })
  await check('manager: API 锚点压缩后重新估算且不重复摘要', async () => {
    let requests = 0
    const provider = new FakeCtxProvider(() => {
      requests++
      return [{ type: 'text', text: '任务仍在进行，保留近期消息。' }, { type: 'done' }]
    })
    const history = new History()
    for (let index = 0; index < 40; index++) {
      history.push(msg(index % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(500)))
    }
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, autoMargin: 2000 })
    manager.afterRequest(5000, history.length)
    if (manager.snapshot().estimatedTokens !== 5000) throw new Error('未使用 API 锚点')
    await manager.beforeRequest('auto')
    const budget = manager.snapshot()
    if (history.length !== 7 || budget.estimatedTokens <= 0 || budget.estimatedTokens >= 1000
      || budget.remainingTokens !== 6000 - budget.estimatedTokens) {
      throw new Error(`压缩后仍沿用旧预算: ${JSON.stringify(budget)}`)
    }
    const version = history.version
    await manager.beforeRequest('auto')
    await manager.beforeRequest('auto')
    if (requests !== 1 || history.version !== version) throw new Error(`重复摘要: ${requests}`)
  })
  await check('manager: 清空及恢复相同条数的历史不沿用旧锚点', () => {
    const history = new History()
    history.push(msg('user', 'a'.repeat(400)))
    history.push(msg('assistant', 'b'.repeat(400)))
    const manager = new ContextManager({ provider: new FakeCtxProvider(), history, cwd: TMP, window: 6000 })
    manager.afterRequest(5000, history.length)
    manager.snapshot()
    history.clear()
    const empty = manager.snapshot()
    if (empty.estimatedTokens !== 0 || empty.remainingTokens !== 6000 || empty.historyMessages !== 0) {
      throw new Error(`清空后预算未归零: ${JSON.stringify(empty)}`)
    }
    history.push(msg('user', 'c'.repeat(400)))
    history.push(msg('assistant', 'd'.repeat(400)))
    manager.afterRequest(5000, history.length)
    manager.snapshot()
    history.clear()
    history.push(msg('user', 'e'.repeat(40)))
    history.push(msg('assistant', 'f'.repeat(80)))
    if (manager.snapshot().estimatedTokens !== 30) throw new Error('相同条数的恢复历史仍沿用旧锚点')
  })
  await check('manager: 等长替换重算，追加及新的 API 用量保留锚点', () => {
    const history = new History()
    history.push(msg('user', 'a'.repeat(40)))
    const manager = new ContextManager({ provider: new FakeCtxProvider(), history, cwd: TMP, window: 6000 })
    manager.afterRequest(1000, history.length)
    manager.snapshot()
    history.push(msg('assistant', 'b'.repeat(80)))
    if (manager.snapshot().estimatedTokens !== 1020) throw new Error('追加消息丢失有效 API 锚点')
    history.replaceRange(0, 1, [msg('user', 'c'.repeat(120))])
    if (manager.snapshot().estimatedTokens !== 50) throw new Error('等长替换后未全量重算')
    manager.afterRequest(700, history.length)
    if (manager.snapshot().estimatedTokens !== 700) throw new Error('新的 API 用量未建立锚点')
    history.push(msg('user', 'd'.repeat(12)))
    if (manager.snapshot().estimatedTokens !== 703) throw new Error('新锚点后增量估算错误')
    history.replaceRange(0, 1, [msg('user', 'e'.repeat(200))])
    manager.afterRequest(900, history.length)
    if (manager.snapshot().estimatedTokens !== 900) throw new Error('结构变化后的新 API 锚点被误清除')
  })
  await check('manager: 增量扫描能存盘新增工具结果', async () => {
    const history = new History()
    history.push(msg('user', '初始消息'))
    const manager = new ContextManager({ provider: new FakeCtxProvider(), history, cwd: TMP, window: 131072 })
    await manager.beforeRequest('auto')
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'spill-1', name: 'read_file', arguments: '{}' }] })
    history.push({ role: 'tool', tool_call_id: 'spill-1', content: '大'.repeat(SPILL_THRESHOLD + 100) })
    await manager.beforeRequest('auto')
    if (!history.view().at(-1)?.content.includes('[已存盘]')) throw new Error('新增工具结果未存盘')
  })

  await check('manager: 两次并发手动压缩共享摘要且保留最近五条', async () => {
    const history = largeHistory()
    const recent = history.all().slice(-5)
    const provider = new DeferredCtxProvider()
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, manualMargin: 2000 })
    const actions = createSessionActions({ history, contextManager: manager, isStreaming: () => false, resetUi: () => {} })
    const first = actions.compact()
    const second = actions.compact()
    await waitFor(provider.started.promise)
    provider.release()
    const results = await Promise.all([first, second])
    if (provider.requests !== 1 || !results.every((result) => result === '压缩完成：早期对话已摘要')
      || history.length !== 7 || JSON.stringify(history.view().slice(2)) !== JSON.stringify(recent)) {
      throw new Error(`重复摘要或丢失近期消息: requests=${provider.requests}, history=${history.length}`)
    }
  })
  await check('manager: 自动与手动压缩重叠只发一次摘要', async () => {
    for (const modes of [['auto', 'manual'], ['manual', 'auto']] as const) {
      const history = largeHistory()
      const recent = history.all().slice(-5)
      const provider = new DeferredCtxProvider()
      const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, autoMargin: 2000, manualMargin: 2000 })
      const requests = modes.map((mode) => manager.beforeRequest(mode))
      await waitFor(provider.started.promise)
      provider.release()
      await Promise.all(requests)
      if (provider.requests !== 1 || JSON.stringify(history.view().slice(2)) !== JSON.stringify(recent)) {
        throw new Error(`${modes.join('/')}: 重复摘要或丢失近期消息`)
      }
    }
  })
  await check('manager: 摘要等待期间追加的消息完整保留', async () => {
    const history = largeHistory()
    const recent = history.all().slice(-5)
    const provider = new DeferredCtxProvider()
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, autoMargin: 2000 })
    const pending = manager.beforeRequest('auto')
    await waitFor(provider.started.promise)
    const appended = msg('user', '摘要期间追加的新问题')
    history.push(appended)
    provider.release()
    await pending
    if (history.length !== 8 || JSON.stringify(history.view().slice(2)) !== JSON.stringify([...recent, appended])) {
      throw new Error('摘要写回丢失或改写了追加消息')
    }
  })
  await check('manager: 等待摘要时清空或等长替换历史会丢弃过期摘要', async () => {
    for (const change of ['clear', 'replace'] as const) {
      const history = largeHistory()
      const provider = new DeferredCtxProvider()
      const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, autoMargin: 2000 })
      const pending = manager.beforeRequest('auto')
      await waitFor(provider.started.promise)
      if (change === 'clear') history.clear()
      else history.replaceRange(0, 1, [msg('user', '替换后的背景')])
      const expected = JSON.stringify(history.view())
      provider.release()
      await pending
      if (JSON.stringify(history.view()) !== expected || manager.lastSummary !== null || manager.breakerOpenState) {
        throw new Error(`${change}: 过期摘要覆盖了新历史`)
      }
      if (change === 'replace') {
        await manager.beforeRequest('auto')
        if (provider.requests !== 2 || history.length !== 7) throw new Error('过期请求结束后未释放压缩状态')
      }
    }
  })
  await check('manager: pre_compact 等待期间结构变化不发送旧摘要请求', async () => {
    const history = largeHistory()
    const provider = new DeferredCtxProvider()
    const started = deferred()
    const gate = deferred()
    const hooks = new HookEngine([])
    hooks.fire = async (event) => {
      if (event === 'pre_compact') {
        started.resolve()
        await gate.promise
      }
    }
    const manager = new ContextManager({ provider, history, hooks, cwd: TMP, window: 6000, autoMargin: 2000 })
    const pending = manager.beforeRequest('auto')
    await waitFor(started.promise)
    history.replaceRange(0, 1, [msg('user', 'Hook 等待期间替换背景')])
    const expected = JSON.stringify(history.view())
    gate.resolve()
    provider.release()
    await pending
    if (provider.requests !== 0 || JSON.stringify(history.view()) !== expected) throw new Error('发送了过期历史的摘要请求')
  })
  await check('manager: 并发失败只计一次，之后可重试且 manual 可绕过熔断', async () => {
    const history = largeHistory()
    const provider = new DeferredCtxProvider()
    provider.events = [{ type: 'error', message: '并发摘要失败' }]
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, autoMargin: 2000, manualMargin: 2000 })
    const requests = [manager.beforeRequest('auto'), manager.beforeRequest('manual'), manager.beforeRequest('manual')]
    await waitFor(provider.started.promise)
    provider.release()
    await Promise.all(requests)
    if (provider.requests !== 1 || manager.breakerOpenState || history.length !== 40) throw new Error('并发失败重复计数或改写历史')
    await manager.beforeRequest('auto')
    await manager.beforeRequest('auto')
    if (Number(provider.requests) !== 3 || !manager.breakerOpenState) throw new Error('失败后不能重试或熔断计数错误')
    provider.events = [{ type: 'text', text: '熔断后手动摘要' }]
    await Promise.all([manager.beforeRequest('auto'), manager.beforeRequest('manual')])
    if (Number(provider.requests) !== 4 || manager.breakerOpenState || Number(history.length) !== 7) {
      throw new Error('等待自动检查后 manual 未绕过熔断')
    }
  })
  await check('manager: manual 未达阈值时并发 auto 仍按自己的阈值压缩', async () => {
    const history = new History()
    for (let index = 0; index < 40; index++) history.push(msg('user', 'x'.repeat(450)))
    const provider = new DeferredCtxProvider()
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, manualMargin: 1000, autoMargin: 2000 })
    const manual = manager.beforeRequest('manual')
    const auto = manager.beforeRequest('auto')
    await waitFor(provider.started.promise)
    provider.release()
    await Promise.all([manual, auto])
    if (provider.requests !== 1 || history.length >= 40 || manager.lastSummary !== '并发摘要') throw new Error('合并检查漏掉自动压缩')
  })
  await check('manager: 会话重置可启动新压缩，旧请求结束不清除新请求', async () => {
    const history = largeHistory()
    const oldStarted = deferred()
    const newStarted = deferred()
    const oldGate = deferred()
    const newGate = deferred()
    let requests = 0
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(): AsyncGenerator<StreamEvent> {
        const index = requests++
        if (index === 0) oldStarted.resolve()
        else newStarted.resolve()
        await (index === 0 ? oldGate.promise : newGate.promise)
        yield { type: 'text', text: index === 0 ? '旧会话摘要' : '新会话摘要' }
      },
    }
    const manager = new ContextManager({ provider, history, cwd: TMP, window: 6000, autoMargin: 2000, manualMargin: 2000 })
    const oldRequest = manager.beforeRequest('auto')
    await waitFor(oldStarted.promise)
    history.clear()
    manager.reset()
    for (const message of largeHistory().view()) history.push(message)
    const recent = history.all().slice(-5)
    const newRequest = manager.beforeRequest('auto')
    await waitFor(newStarted.promise)
    oldGate.resolve()
    await oldRequest
    const joined = manager.beforeRequest('manual')
    newGate.resolve()
    await Promise.all([newRequest, joined])
    if (requests !== 2 || manager.lastSummary !== '新会话摘要' || JSON.stringify(history.view().slice(2)) !== JSON.stringify(recent)) {
      throw new Error('旧请求阻塞、清除或覆盖了新会话压缩')
    }
  })

  // ---------- replaceRange ----------
  await check('history: replaceRange 替换', () => {
    const h = new History()
    h.push(msg('user', 'a'))
    h.push(msg('user', 'b'))
    h.push(msg('user', 'c'))
    h.replaceRange(0, 2, [summaryMessage('摘要')])
    const all = h.all()
    if (all.length !== 2 || all[0].content.includes('摘要') === false) throw new Error(`replaceRange 失败: ${JSON.stringify(all)}`)
    if (boundaryMessage().content.length === 0) throw new Error('边界消息为空')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('context 测试异常:', e)
  process.exit(1)
})
