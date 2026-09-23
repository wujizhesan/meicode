// MeiCode 冒烟验证脚本：node test/smoke.ts 运行
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadConfig, loadConfigWithMcp } from '../src/config/loader.ts'
import { History } from '../src/session/history.ts'
import { createProvider } from '../src/provider/index.ts'
import type { ChatMessage, StreamEvent } from '../src/provider/types.ts'
import type { ProviderConfig } from '../src/config/types.ts'

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

function expectThrow(name: string, fn: () => unknown, match: string) {
  check(name, () => {
    try {
      fn()
      throw new Error('期望抛错但没有')
    } catch (e) {
      const msg = (e as Error).message
      if (!msg.includes(match)) throw new Error(`错误信息不符: 期望含「${match}」，实际「${msg}」`)
    }
  })
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<{ events: StreamEvent[]; text: string; thinking: string }> {
  const events: StreamEvent[] = []
  let text = ''
  let thinking = ''
  for await (const ev of gen) {
    events.push(ev)
    if (ev.type === 'text') text += ev.text
    if (ev.type === 'thinking') thinking += ev.text
  }
  return { events, text, thinking }
}

// fake server：分批发送 SSE 块（模拟真实网络的 chunk 间隔），验证真流式
function fakeServerChunked(chunks: string[], intervalMs: number) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(chunks[i])
          i++
        } else {
          clearInterval(timer)
          res.end()
        }
      }, intervalMs)
    })
    server.listen(0, () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => {
          server.closeAllConnections?.()
          server.close()
        },
      })
    })
  })
}

// fake server：返回预设 SSE 体，捕获请求（方法/头/体），供归一化断言
function fakeServer(sseBody: string, status = 200) {
  return new Promise<{ url: string; requests: { method: string; headers: Record<string, string | string[] | undefined>; body: string }[]; close: () => void }>((resolve) => {
    const requests: { method: string; headers: Record<string, string | string[] | undefined>; body: string }[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        requests.push({ method: req.method ?? '', headers: req.headers, body })
        res.writeHead(status, { 'content-type': 'text/event-stream' })
        res.write(sseBody)
        res.end()
      })
    })
    server.listen(0, () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => {
          server.closeAllConnections?.()
          server.close()
        },
      })
    })
  })
}

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[]}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想，"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"这是个测试。"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好，"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"世界！"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

function makeCfg(protocol: 'anthropic' | 'openai', base_url: string): ProviderConfig {
  return { name: 't', protocol, model: 'm', base_url, api_key: 'k' }
}

async function main() {
  const FIXTURE_DIR = join(import.meta.dirname, 'fixtures')
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const fixture = (name: string, content: string) => {
    const p = join(FIXTURE_DIR, name)
    writeFileSync(p, content, 'utf8')
    return p
  }

  // ---------- config 层 ----------
  const good = fixture('good.yaml', `
name: my-claude
protocol: anthropic
model: claude-sonnet-5
base_url: https://api.anthropic.com
api_key: sk-ant-test
thinking: true
`)
  const cfg = loadConfig(good)
  await check('config: 正常解析六字段', () => {
    if (cfg.name !== 'my-claude' || cfg.protocol !== 'anthropic' || cfg.model !== 'claude-sonnet-5') throw new Error('字段值不符')
    if (cfg.base_url !== 'https://api.anthropic.com' || cfg.api_key !== 'sk-ant-test') throw new Error('字段值不符')
    if (cfg.thinking !== true) throw new Error('thinking 未解析')
  })
  await expectThrow('config: 缺 api_key 报错', () => loadConfig(fixture('missing.yaml', 'name: x\nprotocol: openai\nmodel: gpt-5\nbase_url: https://api.openai.com\n')), 'api_key')
  await expectThrow('config: 非法 protocol 报错', () => loadConfig(fixture('badproto.yaml', 'name: x\nprotocol: gemini\nmodel: x\nbase_url: x\napi_key: x\n')), '不支持的 protocol')
  await expectThrow('config: 文件不存在报错', () => loadConfig(join(FIXTURE_DIR, 'nope.yaml')), '配置文件不存在')
  await check('config: 从环境变量读取 API key', () => {
    process.env.MEICODE_TEST_API_KEY = 'secret-from-env'
    try {
      const envCfg = loadConfig(fixture('env-key.yaml', 'name: x\nprotocol: openai\nmodel: m\nbase_url: https://example.com\napi_key_env: MEICODE_TEST_API_KEY\n'))
      if (envCfg.api_key !== 'secret-from-env') throw new Error('环境变量密钥未解析')
    } finally {
      delete process.env.MEICODE_TEST_API_KEY
    }
  })
  await check('config: 模型目录下传上下文与输出预算', () => {
    const catalogCfg = loadConfig(fixture('catalog.yaml', 'provider: bigmodel\napi_key: x\n'))
    if (catalogCfg.context_window !== 200000 || catalogCfg.max_output_tokens !== 64000) {
      throw new Error(`模型预算未下传: ${JSON.stringify(catalogCfg)}`)
    }
  })
  await expectThrow('config: 非法模型预算报错', () => loadConfig(fixture('bad-budget.yaml', 'name: x\nprotocol: openai\nmodel: m\nbase_url: https://example.com\napi_key: x\ncontext_window: 0\n')), 'context_window')
  await check('config: 显式配置文件同时加载 MCP/A2A', () => {
    const explicit = fixture('explicit-services.yaml', `
name: explicit
protocol: openai
model: m
base_url: https://example.com
api_key: x
mcpServers:
  explicit-mcp:
    type: http
    url: https://mcp.example.com
a2aAgents:
  explicit-a2a:
    url: https://a2a.example.com
`)
    const loaded = loadConfigWithMcp(explicit)
    if (!loaded.mcpServers.some((server) => server.name === 'explicit-mcp')) throw new Error('显式 MCP 配置被忽略')
    if (!loaded.a2aAgents.some((agent) => agent.name === 'explicit-a2a')) throw new Error('显式 A2A 配置被忽略')
  })

  // ---------- provider 工厂 ----------
  await check('工厂: anthropic 分派', () => {
    const p = createProvider(makeCfg('anthropic', 'http://x'))
    if (p.protocol !== 'anthropic') throw new Error('分派错误')
  })
  await check('工厂: openai 分派', () => {
    const p = createProvider(makeCfg('openai', 'http://x'))
    if (p.protocol !== 'openai') throw new Error('分派错误')
  })

  // ---------- Anthropic 归一化 ----------
  const ant = await fakeServer(ANTHROPIC_SSE)
  const anthropic = createProvider(makeCfg('anthropic', ant.url))
  const history: ChatMessage[] = [{ role: 'user', content: '你好' }]
  const antRes = await collect(anthropic.streamChat(history, { thinking: true }))
  await check('anthropic: 事件序列 thinking/text/done', () => {
    const types = antRes.events.map((e) => e.type)
    if (types.join(',') !== 'thinking,thinking,text,text,done') throw new Error(`序列不符: ${types.join(',')}`)
  })
  await check('anthropic: text 拼回完整正文', () => {
    if (antRes.text !== '你好，世界！') throw new Error(`正文不符: ${antRes.text}`)
  })
  await check('anthropic: thinking 拼回完整思考', () => {
    if (antRes.thinking !== '让我想想，这是个测试。') throw new Error(`思考不符: ${antRes.thinking}`)
  })
  await check('anthropic: 请求头与 body（thinking 开关）', () => {
    const req = ant.requests[0]
    if (req.method !== 'POST') throw new Error('方法不是 POST')
    if (req.headers['x-api-key'] !== 'k') throw new Error('x-api-key 头缺失')
    if (req.headers['anthropic-version'] !== '2023-06-01') throw new Error('anthropic-version 头缺失')
    const body = JSON.parse(req.body)
    if (body.stream !== true) throw new Error('未开流式')
    if (body.thinking?.type !== 'enabled') throw new Error('thinking 未开启')
    if (body.messages[0].content !== '你好') throw new Error('消息未转换')
  })
  await check('anthropic: 连续 user 合并', async () => {
    const server = await fakeServer(ANTHROPIC_SSE)
    const p = createProvider(makeCfg('anthropic', server.url))
    await collect(p.streamChat([{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }], {}))
    const body = JSON.parse(server.requests[0].body)
    if (body.messages.length !== 1) throw new Error(`应合并为 1 条，实际 ${body.messages.length}`)
    if (!body.messages[0].content.includes('A') || !body.messages[0].content.includes('B')) throw new Error('合并内容不符')
    server.close()
  })
  ant.close()

  // ---------- OpenAI 归一化 ----------
  const oai = await fakeServer(OPENAI_SSE)
  const openai = createProvider(makeCfg('openai', oai.url))
  const oaiRes = await collect(openai.streamChat(history, {}))
  await check('openai: 事件序列 text/done', () => {
    const types = oaiRes.events.map((e) => e.type)
    if (types.join(',') !== 'text,text,done') throw new Error(`序列不符: ${types.join(',')}`)
  })
  await check('openai: text 拼回完整正文', () => {
    if (oaiRes.text !== 'Hello world') throw new Error(`正文不符: ${oaiRes.text}`)
  })
  await check('openai: 请求头与 body', () => {
    const req = oai.requests[0]
    if (req.headers['authorization'] !== 'Bearer k') throw new Error('Bearer 头缺失')
    const body = JSON.parse(req.body)
    if (body.stream !== true) throw new Error('未开流式')
    if (body.messages[0].role !== 'user' || body.messages[0].content !== '你好') throw new Error('消息不符')
  })
  await check('openai: 配置输出预算进入请求体', async () => {
    const server = await fakeServer(OPENAI_SSE)
    const p = createProvider({ ...makeCfg('openai', server.url), max_output_tokens: 4096 })
    await collect(p.streamChat(history, {}))
    if (JSON.parse(server.requests[0].body).max_tokens !== 4096) throw new Error('max_output_tokens 未生效')
    server.close()
  })
  oai.close()

  await check('openai: 请求体 tools 为完整 OpenAI 格式', async () => {
    const server = await fakeServer(OPENAI_SSE)
    const p = createProvider(makeCfg('openai', server.url))
    const toolDef = {
      type: 'function' as const,
      function: {
        name: 'read_file',
        description: '读取文件',
        parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }
    await collect(p.streamChat(history, { tools: [toolDef] }))
    const body = JSON.parse(server.requests[0].body)
    if (!body.tools || body.tools.length !== 1) throw new Error('缺 tools 字段')
    if (body.tools[0].type !== 'function' || !body.tools[0].function.name || !body.tools[0].function.parameters) {
      throw new Error(`tools 格式不符: ${JSON.stringify(body.tools[0])}`)
    }
    server.close()
  })

  // ---------- tool_calls 分片聚合 ----------
  await check('openai: tool_calls 三帧分片聚合', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"grep_code","arguments":"{\\"pattern\\":\\"imp"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"ort\\"}"}}]},"index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const server = await fakeServer(sse)
    const p = createProvider(makeCfg('openai', server.url))
    const res = await collect(p.streamChat(history, { tools: [] }))
    const calls = res.events.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call')
    if (calls.length !== 2) throw new Error(`tool_call 事件数 ${calls.length}`)
    const c1 = calls.find((c) => c.id === 'call_1')
    if (!c1 || c1.name !== 'read_file' || c1.arguments.path !== 'a.txt') {
      throw new Error(`call_1 聚合不符: ${JSON.stringify(c1)}`)
    }
    const c2 = calls.find((c) => c.id === 'call_2')
    if (!c2 || c2.name !== 'grep_code' || c2.arguments.pattern !== 'import') {
      throw new Error(`call_2 聚合不符: ${JSON.stringify(c2)}`)
    }
    if (res.events[res.events.length - 1].type !== 'done') throw new Error('缺 done')
    server.close()
  })

  await check('openai: 历史消息转换（tool_calls + tool 消息）', async () => {
    const server = await fakeServer(OPENAI_SSE)
    const p = createProvider(makeCfg('openai', server.url))
    const toolHistory: ChatMessage[] = [
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
    ]
    await collect(p.streamChat(toolHistory, {}))
    const body = JSON.parse(server.requests[0].body)
    const assistant = body.messages[1]
    if (assistant.content !== null) throw new Error(`assistant content 应为 null: ${JSON.stringify(assistant.content)}`)
    if (!assistant.tool_calls || assistant.tool_calls[0].function.arguments !== '{"path":"a.txt"}') {
      throw new Error(`tool_calls 转换不符: ${JSON.stringify(assistant.tool_calls)}`)
    }
    const toolMsg = body.messages[2]
    if (toolMsg.role !== 'tool' || toolMsg.tool_call_id !== 'call_1' || toolMsg.content !== '文件内容') {
      throw new Error(`tool 消息转换不符: ${JSON.stringify(toolMsg)}`)
    }
    server.close()
  })

  await check('openai: 工具参数解析失败 → 结构化错误', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"read_file","arguments":"{bad json"}}]},"index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const server = await fakeServer(sse)
    const res = await collect(createProvider(makeCfg('openai', server.url)).streamChat(history, { tools: [] }))
    const hasErr = res.events.some((e) => e.type === 'error' && e.message.includes('工具参数解析失败'))
    if (!hasErr) throw new Error(`应报解析失败: ${JSON.stringify(res.events)}`)
    server.close()
  })

  await check('openai: usage chunk 解析', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const server = await fakeServer(sse)
    const res = await collect(createProvider(makeCfg('openai', server.url)).streamChat(history, {}))
    const usage = res.events.find((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage')
    if (!usage || usage.inputTokens !== 10 || usage.outputTokens !== 5) throw new Error(`usage 解析不符: ${JSON.stringify(res.events)}`)
    server.close()
  })

  await check('openai: 无 usage chunk 不产生 usage 事件', async () => {
    const server = await fakeServer(OPENAI_SSE)
    const res = await collect(createProvider(makeCfg('openai', server.url)).streamChat(history, {}))
    if (res.events.some((e) => e.type === 'usage')) throw new Error('不应有 usage 事件')
    server.close()
  })

  // ---------- 真流式验证 ----------
  await check('流式: 事件随时间分批到达（非一次性吐完）', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo "},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"},"index":0}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const server = await fakeServerChunked(chunks, 100)
    const p = createProvider(makeCfg('openai', server.url))
    const times: number[] = []
    let text = ''
    for await (const ev of p.streamChat(history, {})) {
      if (ev.type === 'text') {
        times.push(Date.now())
        text += ev.text
      }
    }
    server.close()
    if (times.length !== 3) throw new Error(`text 事件数不符: ${times.length}`)
    if (times[2] - times[0] < 150) throw new Error(`事件一次性到达（跨度 ${times[2] - times[0]}ms），非流式`)
    if (text !== 'Hello world') throw new Error(`正文不符: ${text}`)
  })

  // ---------- session 历史 ----------
  await check('session: push/all/clear 与副本语义', () => {
    const h = new History()
    h.push({ role: 'user', content: 'A' })
    h.push({ role: 'assistant', content: 'B' })
    h.push({ role: 'user', content: 'C' })
    if (h.length !== 3) throw new Error(`length=${h.length}`)
    const all = h.all()
    if (all[1].content !== 'B' || all[2].role !== 'user') throw new Error('all() 内容不符')
    all[0].content = 'MUTATED'
    if (h.all()[0].content !== 'A') throw new Error('all() 泄漏内部引用')
    h.clear()
    if (h.all().length !== 0) throw new Error('clear 失败')
  })

  // ---------- 错误路径 ----------
  await check('anthropic: 流中 error 事件', async () => {
    const server = await fakeServer('data: {"type":"error","error":{"message":"模拟 API 错误"}}\n\n')
    const res = await collect(createProvider(makeCfg('anthropic', server.url)).streamChat(history, {}))
    const last = res.events[res.events.length - 1]
    if (last.type !== 'error' || !last.message.includes('模拟 API 错误')) throw new Error('error 事件不符')
    server.close()
  })
  await check('openai: 非 2xx 报错', async () => {
    const server = await fakeServer('{"error":{"message":"invalid key"}}', 401)
    const res = await collect(createProvider(makeCfg('openai', server.url)).streamChat(history, {}))
    const last = res.events[res.events.length - 1]
    if (last.type !== 'error' || !last.message.includes('HTTP 401')) throw new Error(`期望 HTTP 401 错误，实际: ${JSON.stringify(last)}`)
    server.close()
  })

  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('冒烟脚本异常:', e)
  process.exit(1)
})
