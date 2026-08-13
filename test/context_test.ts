// 上下文管理测试：估算/存盘/摘要/触发/熔断/保留
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { History } from '../src/session/history.ts'
import {
  TokenEstimator,
  spillBatch,
  spillContent,
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
  await check('manager: 熔断——失败 3 次停自动，manual 绕过', async () => {
    const p = new FakeCtxProvider()
    p.failSummaries = true
    const history = new History()
    for (let i = 0; i < 20; i++) {
      history.push(msg('user', `u${i}` + 'x'.repeat(500)))
      history.push(msg('assistant', `a${i}`))
    }
    const manager = new ContextManager({ provider: p, history, cwd: TMP, window: 3000, autoMargin: 1000 })
    await manager.beforeRequest('auto') // 1
    await manager.beforeRequest('auto') // 2
    await manager.beforeRequest('auto') // 3 → 熔断
    if (!manager.breakerOpenState) throw new Error('熔断未开启')
    const before = history.all().length
    await manager.beforeRequest('auto') // 熔断后不再尝试（无变化）
    if (history.all().length !== before) throw new Error('熔断后仍尝试摘要')
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
