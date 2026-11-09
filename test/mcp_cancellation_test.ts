import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpClientManager, type RemoteToolInfo } from '../src/mcp/manager.ts'
import { toMewTool } from '../src/mcp/adapter.ts'
import { withIdleTimeout } from '../src/provider/timeout.ts'
import type { ToolResult } from '../src/tools/types.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function heldRequest() {
  return { started: deferred<void>(), release: deferred<void>(), cancelled: deferred<void>() }
}

function fixture(paused = false) {
  const info: RemoteToolInfo = {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }
  const calls: string[] = []
  const holds = new Map<string, ReturnType<typeof heldRequest>>()
  const client = new Client({ name: 'cancel-test-client', version: '1' })
  const server = new Server({ name: 'cancel-test-server', version: '1' }, { capabilities: { tools: {} } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ ...info, inputSchema: { type: 'object' as const } }] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const text = String(request.params.arguments?.text ?? '')
    calls.push(text)
    const hold = holds.get(text)
    if (hold) {
      extra.signal.addEventListener('abort', () => hold.cancelled.resolve(), { once: true })
      hold.started.resolve()
      await hold.release.promise
    }
    return { content: [{ type: 'text', text }] }
  })
  const manager = new McpClientManager([{ name: 'fixture', type: 'http', url: 'http://127.0.0.1' }])
  const connectionStarted = deferred<void>()
  const continueConnection = deferred<void>()
  if (!paused) continueConnection.resolve()
  let connections = 0
  const connector = manager as unknown as { connect: () => Promise<Client> }
  connector.connect = async () => {
    connections++
    connectionStarted.resolve()
    await continueConnection.promise
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    manager.connectCount++
    return client
  }
  return {
    manager,
    tool: toMewTool('fixture', info, manager),
    calls,
    holds,
    connectionStarted,
    continueConnection,
    connections: () => connections,
    async close() {
      continueConnection.resolve()
      for (const hold of holds.values()) hold.release.resolve()
      await manager.closeAll()
      await client.close()
      await server.close()
    },
  }
}

function assertCancelled(result: ToolResult) {
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /取消/)
  assert.equal(result.output, '')
  assert.equal(result.evidence, undefined)
}

{
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  try {
    assertCancelled(await f.manager.callTool('fixture', 'echo', { text: 'direct' }, controller.signal))
    assertCancelled(await f.tool.execute({ text: 'adapter' }, { cwd: process.cwd(), signal: controller.signal }))
    assert.equal(f.connections(), 0)
    assert.equal(f.manager.connectCount, 0)
    assert.deepEqual(f.calls, [])
  } finally {
    await f.close()
  }
  console.log('  ✓ MCP: 预先取消时不建立连接或执行工具')
}

{
  const f = fixture(true)
  const controller = new AbortController()
  try {
    const pending = f.tool.execute({ text: 'cancelled' }, { cwd: process.cwd(), signal: controller.signal })
    await withIdleTimeout(f.connectionStarted.promise, 1000)
    const peer = f.tool.execute({ text: 'peer' }, { cwd: process.cwd() })
    controller.abort()
    assertCancelled(await withIdleTimeout(pending, 1000))
    assert.deepEqual(f.calls, [])
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    f.continueConnection.resolve()
    const result = await withIdleTimeout(peer, 1000)
    assert.equal(result.success, true)
    assert.equal(result.output, 'peer')
    assert.deepEqual(f.calls, ['peer'])
    assert.equal(f.connections(), 1)
    assert.equal(f.manager.connectCount, 1)
  } finally {
    await f.close()
  }
  console.log('  ✓ MCP: 连接期间取消立即返回且共享连接仍可用')
}

{
  const f = fixture()
  const controller = new AbortController()
  const slow = heldRequest()
  const peer = heldRequest()
  f.holds.set('slow', slow)
  f.holds.set('peer', peer)
  try {
    await f.manager.discoverAll()
    const pending = f.tool.execute({ text: 'slow' }, { cwd: process.cwd(), signal: controller.signal })
    await withIdleTimeout(slow.started.promise, 1000)
    const other = f.tool.execute({ text: 'peer' }, { cwd: process.cwd() })
    await withIdleTimeout(peer.started.promise, 1000)
    controller.abort(new Error('stop'))
    assertCancelled(await withIdleTimeout(pending, 1000))
    await withIdleTimeout(slow.cancelled.promise, 1000)
    assert.ok(f.manager.getTools('fixture'))
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    peer.release.resolve()
    const result = await withIdleTimeout(other, 1000)
    assert.equal(result.success, true)
    assert.equal(result.output, 'peer')
    slow.release.resolve()
    const reused = await f.manager.callTool('fixture', 'echo', { text: 'reused' })
    assert.equal(reused.success, true)
    assert.equal(reused.output, 'reused')
    assert.equal(f.connections(), 1)
    assert.equal(f.manager.connectCount, 1)
  } finally {
    await f.close()
  }
  console.log('  ✓ MCP: 取消通知送达服务端且并发请求及后续调用正常')
}

{
  const f = fixture()
  const controller = new AbortController()
  try {
    for (let index = 0; index < 12; index++) {
      const result = await f.tool.execute({ text: String(index) }, { cwd: process.cwd(), signal: controller.signal })
      assert.equal(result.success, true)
      assert.equal(result.output, String(index))
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    }
    assert.equal(f.connections(), 1)
  } finally {
    await f.close()
  }
  console.log('  ✓ MCP: 重复调用不累积会话取消监听')
}

console.log('mcp_cancellation_test: 4 passed')
