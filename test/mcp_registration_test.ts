import { createMcpToolRegistrar } from '../src/mcp/index.ts'
import type { McpClientManager, RemoteToolInfo } from '../src/mcp/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'

const tools = new Map<string, RemoteToolInfo[]>([
  ['good', [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }]],
  ['later', [{ name: 'sum', description: 'sum', inputSchema: { type: 'object' } }]],
])
let attempts = 0
const manager = {
  discoverAll: async () => {
    attempts++
    return attempts === 1
      ? { ok: ['good'], failed: [{ name: 'later', error: 'offline' }] }
      : { ok: ['good', 'later'], failed: [] }
  },
  getTools: (name: string) => tools.get(name),
  callTool: async () => ({ success: true, output: 'ok' }),
} as unknown as McpClientManager

const registry = new ToolRegistry()
const registrar = createMcpToolRegistrar(registry, manager)
const first = await registrar.discover()
if (registrar.ready) throw new Error('registrar became ready while one server was offline')
if (first.toolCount !== 1 || first.registered.join(',') !== 'good') {
  throw new Error(`first registration changed: ${JSON.stringify(first)}`)
}

const second = await registrar.discover()
if (!registrar.ready) throw new Error('registrar did not become ready after retry')
if (second.toolCount !== 1 || second.registered.join(',') !== 'later') {
  throw new Error(`retry did not register only recovered server: ${JSON.stringify(second)}`)
}
if (!registry.get('good_echo') || !registry.get('later_sum') || registry.list().length !== 2) {
  throw new Error(`registry contents changed: ${registry.list().map((tool) => tool.name).join(',')}`)
}

const third = await registrar.discover()
if (third.toolCount !== 0 || third.registered.length !== 0 || registry.list().length !== 2) {
  throw new Error('ready servers were registered more than once')
}

console.log('mcp_registration_test passed')
