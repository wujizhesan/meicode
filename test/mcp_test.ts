// MCP 客户端测试：配置/发现/注册/调用/隔离/HTTP/缓存
import { spawn, execSync } from 'node:child_process'
import { join } from 'node:path'
import { parseMcpServers, McpClientManager, registerMcpTools } from '../src/mcp/index.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'

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

const FIXTURE = join(import.meta.dirname, 'fixtures_mcp', 'mcp_server.ts')
const HTTP_FIXTURE = join(import.meta.dirname, 'fixtures_mcp', 'mcp_http_server.ts')
const RUN = 'node'

function stdioServer(name: string, command = 'node'): Parameters<typeof parseMcpServers>[0] {
  return {
    [name]: { type: 'stdio', command, args: ['--import', 'tsx', FIXTURE] },
  }
}

// 启动 HTTP fixture，等第一行端口输出
async function startHttpServer(): Promise<{ url: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(RUN, ['--import', 'tsx', HTTP_FIXTURE])
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const m = out.match(/(\d+)/)
      if (m) {
        resolve({ url: `http://127.0.0.1:${m[1]}`, kill: () => child.kill() })
      }
    })
    setTimeout(() => reject(new Error('HTTP fixture 启动超时')), 8000)
  })
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  createTools({ cwd: process.cwd() }).forEach((t) => r.register(t))
  return r
}

async function main() {
  // ---------- 配置解析 ----------
  await check('配置: 两层合并（项目盖用户）', () => {
    const user = { echo: { type: 'stdio', command: 'node', args: ['a'] } }
    const project = { echo: { type: 'stdio', command: 'bun', args: ['b'] }, extra: { type: 'http', url: 'http://x' } }
    const { servers } = parseMcpServers(user, project)
    const echo = servers.find((s) => s.name === 'echo')
    if (!echo || echo.type !== 'stdio' || echo.command !== 'bun') throw new Error(`项目层未覆盖: ${JSON.stringify(echo)}`)
    if (!servers.find((s) => s.name === 'extra')) throw new Error('项目层新增缺失')
  })

  await check('配置: ${VAR} 展开与缺失保留', () => {
    process.env.MEW_TEST_VAR = 'hello'
    const { servers } = parseMcpServers(
      { s1: { type: 'stdio', command: '${MEW_TEST_VAR}', args: ['${MEW_TEST_VAR}', '${MEW_MISSING_VAR}'] } },
      null,
    )
    const s1 = servers[0]
    if (s1.type !== 'stdio' || s1.command !== 'hello') throw new Error('展开失败')
    if (s1.args?.[0] !== 'hello' || s1.args?.[1] !== '${MEW_MISSING_VAR}') throw new Error('args 展开/保留失败')
    delete process.env.MEW_TEST_VAR
  })

  await check('配置: 数组格式 + type 推断', () => {
    const { servers, skipped } = parseMcpServers(
      [{ name: 'ctx', command: 'npx', args: ['-y', 'x'] }, { name: 'bad' }],
      null,
    )
    const ctx = servers.find((s) => s.name === 'ctx')
    if (!ctx || ctx.type !== 'stdio' || ctx.command !== 'npx') throw new Error(`数组格式解析失败: ${JSON.stringify(ctx)}`)
    if (ctx.args?.[1] !== 'x') throw new Error('args 未透传')
    if (skipped.length !== 1) throw new Error('缺 command 的条目未跳过')
  })

  await check('配置: 坏条目跳过', () => {
    const { servers, skipped } = parseMcpServers(
      { bad: { type: 'weird' }, ok: { type: 'stdio', command: 'node' } },
      null,
    )
    if (servers.length !== 1 || servers[0].name !== 'ok') throw new Error('坏条目未跳过')
    if (skipped.length !== 1) throw new Error('跳过列表缺失')
  })

  // ---------- stdio 发现与调用 ----------
  await check('stdio: 发现并调用 echo', async () => {
    const manager = new McpClientManager([{ name: 'fixture', type: 'stdio', command: 'node', args: ['--import', 'tsx', FIXTURE] }])
    const { ok, failed } = await manager.discoverAll()
    if (ok.length !== 1 || failed.length > 0) throw new Error(`发现失败: ${JSON.stringify({ ok, failed })}`)
    const tools = manager.getTools('fixture')
    if (!tools || tools.length !== 2 || !tools.find((t) => t.name === 'echo')) throw new Error('工具列表不符')
    const result = await manager.callTool('fixture', 'echo', { text: '你好MCP' })
    if (!result.success || !result.output.includes('你好MCP')) throw new Error(`调用失败: ${JSON.stringify(result)}`)
    const sum = await manager.callTool('fixture', 'add', { a: 3, b: 4 })
    if (!sum.success || !sum.output.includes('7')) throw new Error(`add 失败: ${JSON.stringify(sum)}`)
    await manager.closeAll()
  })

  await check('stdio: 缓存——重复 discover 不重连', async () => {
    const manager = new McpClientManager([{ name: 'fixture', type: 'stdio', command: 'node', args: ['--import', 'tsx', FIXTURE] }])
    await manager.discoverAll()
    const c1 = manager.connectCount
    await manager.discoverAll()
    if (manager.connectCount !== c1) throw new Error(`重复 discover 重连了: ${c1} → ${manager.connectCount}`)
    await manager.closeAll()
  })

  await check('隔离: 坏 Server 不阻塞好 Server', async () => {
    const manager = new McpClientManager([
      { name: 'bad', type: 'stdio', command: 'no_such_command_xyz', args: [] },
      { name: 'good', type: 'stdio', command: 'node', args: ['--import', 'tsx', FIXTURE] },
    ])
    const { ok, failed } = await manager.discoverAll()
    if (!ok.includes('good') || !failed.find((f) => f.name === 'bad')) {
      throw new Error(`隔离失败: ${JSON.stringify({ ok, failed })}`)
    }
    const result = await manager.callTool('good', 'echo', { text: 'still works' })
    if (!result.success) throw new Error('好 Server 调用失败')
    await manager.closeAll()
  })

  // ---------- 注册与 Agent 视角 ----------
  await check('注册: 前缀命名进 registry', async () => {
    const manager = new McpClientManager([{ name: 'fixture', type: 'stdio', command: 'node', args: ['--import', 'tsx', FIXTURE] }])
    const registry = makeRegistry()
    const res = await registerMcpTools(registry, manager)
    if (res.toolCount !== 2) throw new Error(`注册数 ${res.toolCount}`)
    const t = registry.get('fixture_echo')
    if (!t) throw new Error('fixture_echo 未注册')
    if (!t.description.includes('回显')) throw new Error(`描述未透传: ${t.description}`)
    const openai = registry.toOpenAITools()
    if (!openai.find((o) => o.function.name === 'fixture_echo')) throw new Error('Agent 视角缺失远端工具')
    // 通过注册的工具执行
    const r = await t.execute({ text: 'via registry' }, { cwd: process.cwd() })
    if (!r.success || !r.output.includes('via registry')) throw new Error(`注册工具执行失败: ${JSON.stringify(r)}`)
    await manager.closeAll()
  })

  await check('调用: 未知 Server/工具 → 结构化错误', async () => {
    const manager = new McpClientManager([])
    const r1 = await manager.callTool('nope', 'echo', {})
    if (r1.success || !r1.error!.includes('[MCP 错误]')) throw new Error(`未知 Server 未结构化: ${JSON.stringify(r1)}`)
  })

  await check('stdio: 并发首次调用只建立一个连接', async () => {
    const manager = new McpClientManager([{ name: 'fixture', type: 'stdio', command: 'node', args: ['--import', 'tsx', FIXTURE] }])
    const results = await Promise.all([
      manager.callTool('fixture', 'echo', { text: 'one' }),
      manager.callTool('fixture', 'echo', { text: 'two' }),
    ])
    if (results.some((result) => !result.success) || manager.connectCount !== 1) {
      throw new Error(`并发连接未合并: ${JSON.stringify({ results, connectCount: manager.connectCount })}`)
    }
    await manager.closeAll()
  })

  // ---------- HTTP ----------
  await check('http: 发现并调用', async () => {
    const httpServer = await startHttpServer()
    try {
      const manager = new McpClientManager([{ name: 'httpfix', type: 'http', url: httpServer.url }])
      const { ok } = await manager.discoverAll()
      if (!ok.includes('httpfix')) throw new Error('HTTP 发现失败')
      const r = await manager.callTool('httpfix', 'echo', { text: 'over http' })
      if (!r.success || !r.output.includes('over http')) throw new Error(`HTTP 调用失败: ${JSON.stringify(r)}`)
      await manager.closeAll()
    } finally {
      httpServer.kill()
    }
  })

  // 等子进程/连接 handle 清理完成，避免 libuv abort 中断 && 链
  await new Promise((r) => setTimeout(r, 500))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('mcp 测试异常:', e)
  process.exit(1)
})
