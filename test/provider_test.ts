import { toOpenAIMessages } from '../src/provider/openai.ts'
import { toAnthropicBody } from '../src/provider/anthropic.ts'
import type { ChatMessage } from '../src/provider/types.ts'

let passed = 0
let failed = 0
async function check(name: string, fn: () => void): Promise<void> {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}: ${(e as Error).message}`)
  }
}

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg)
}

// ---------- OpenAI 转换 ----------
await check('openai: assistant(tool_calls) → content null + tool_calls 数组', () => {
  const out = toOpenAIMessages([
    { role: 'assistant', content: '查一下', tool_calls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' }] },
  ])
  assert(out[0].role === 'assistant', 'role 错')
  assert(out[0].content === null, 'content 应为 null')
  const tc = (out[0] as { tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] }).tool_calls
  assert(tc.length === 1 && tc[0].id === 'c1' && tc[0].type === 'function' && tc[0].function.name === 'get_weather', 'tool_calls 结构错')
})

await check('openai: tool 消息 → tool_call_id', () => {
  const out = toOpenAIMessages([{ role: 'tool', tool_call_id: 'c1', content: '晴' }])
  assert((out[0] as { tool_call_id: string }).tool_call_id === 'c1', 'tool_call_id 缺失')
})

await check('openai: 普通消息原样', () => {
  const out = toOpenAIMessages([{ role: 'user', content: 'hi' }])
  assert(out[0].role === 'user' && out[0].content === 'hi', 'user 消息转换错')
})

// ---------- Anthropic 转换 ----------
const TOOLS = [
  { type: 'function' as const, function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' as const, properties: {} } } },
]

await check('anthropic: system 提取到独立字段', () => {
  const body = toAnthropicBody(
    [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
    'm', false,
  )
  assert(body.system === '你是助手', 'system 未提取')
  const msgs = body.messages as { role: string }[]
  assert(msgs.length === 1 && msgs[0].role === 'user', 'system 不应在 messages 里')
})

await check('anthropic: assistant(tool_calls) → tool_use block', () => {
  const body = toAnthropicBody(
    [{ role: 'user', content: '天气' }, { role: 'assistant', content: '查', tool_calls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' }] }],
    'm', false,
  )
  const asst = (body.messages as { role: string; content: { type: string; id?: string; name?: string; input?: unknown }[] }[])[1]
  assert(asst.content.length === 2, '应有 text + tool_use 两个 block')
  const tu = asst.content[1]
  assert(tu.type === 'tool_use' && tu.id === 'c1' && tu.name === 'get_weather', 'tool_use 结构错')
  assert(JSON.stringify(tu.input) === '{"city":"北京"}', 'input 未解析为对象')
})

await check('anthropic: tool 消息 → tool_result user 块', () => {
  const body = toAnthropicBody(
    [{ role: 'user', content: '天气' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }] }, { role: 'tool', tool_call_id: 'c1', content: '晴' }],
    'm', false,
  )
  const last = (body.messages as { role: string; content: { type: string; tool_use_id?: string; content?: string }[] }[])[2]
  assert(last.role === 'user' && last.content[0].type === 'tool_result' && last.content[0].tool_use_id === 'c1', 'tool_result 结构错')
})

await check('anthropic: tools 参数格式（无 function wrapper）', () => {
  const body = toAnthropicBody([{ role: 'user', content: 'x' }], 'm', false, TOOLS)
  const tools = body.tools as { name: string; description: string; input_schema: unknown }[]
  assert(tools.length === 1 && tools[0].name === 'get_weather' && tools[0].input_schema, 'tools 格式错')
  assert(!('function' in tools[0]), '不应有 function wrapper')
})

await check('anthropic: 连续同角色合并 + 带 tool_calls 不合并', () => {
  const body = toAnthropicBody(
    [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'x', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ],
    'm', false,
  )
  const msgs = body.messages as { role: string; content: unknown }[]
  assert(msgs.length === 3, `应合并 user（${msgs.length} 条）`)
  assert(msgs[0].role === 'user' && String(msgs[0].content).includes('a\n\nb'), 'user 未合并')
})

await check('anthropic: 多工具轮 result 合并到同一条消息(400 根因回归)', () => {
  // Anthropic 要求 assistant(tool_use) 的所有 result 在"下一条消息"——
  // 分开成多条会报 tool_use without tool_result；但合并不能丢 id
  const body = toAnthropicBody(
    [
      { role: 'user', content: '检查状态' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', name: 'run_command', arguments: '{}' },
        { id: 'c2', name: 'run_command', arguments: '{}' },
        { id: 'c3', name: 'run_command', arguments: '{}' },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      { role: 'tool', tool_call_id: 'c3', content: 'r3' },
    ],
    'm', false,
  )
  const msgs = body.messages as { role: string; content: unknown }[]
  const blocks = (m: { content: unknown }): { type: string; tool_use_id?: string; id?: string }[] =>
    Array.isArray(m.content) ? (m.content as { type: string; tool_use_id?: string; id?: string }[]) : []
  const toolUses = msgs.flatMap((m) => blocks(m).filter((b) => b.type === 'tool_use').map((b) => b.id))
  const toolResults = msgs.flatMap((m) => blocks(m).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id))
  assert(toolUses.length === 3, `tool_use 应有 3 个,实际 ${toolUses.length}`)
  assert(toolResults.length === 3, `tool_result 应有 3 条,实际 ${toolResults.length}(丢 id 了!)`)
  // 紧邻校验:assistant(tool_use) 的下一条消息必须含全部 result
  for (let i = 0; i < msgs.length; i++) {
    const tus = blocks(msgs[i]).filter((b) => b.type === 'tool_use').map((b) => b.id)
    if (tus.length === 0) continue
    const next = msgs[i + 1]
    const nextTrs = next ? blocks(next).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []
    assert(tus.every((id) => nextTrs.includes(id)), `tool_use ${tus} 无紧邻 result(应合并到同一条消息)`)
  }
})

await check('anthropic: thinking 参数', () => {
  const body = toAnthropicBody([{ role: 'user', content: 'x' }], 'm', true)
  assert((body.thinking as { type: string }).type === 'enabled', 'thinking 未开启')
  assert(body.max_tokens === 32000, 'thinking 时 max_tokens 应 32000')
})

console.log(`\nprovider_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
