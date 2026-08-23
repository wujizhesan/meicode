// 最小 Streamable HTTP MCP Server（echo 工具）——测试用（无状态模式，官方示例结构）
// 运行后打印监听端口（第一行 stdout）
import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const getServer = () => {
  const server = new Server(
    { name: 'mewcode-test-http-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: '回显输入的文本（HTTP）',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    if (name === 'echo') {
      return { content: [{ type: 'text', text: `http-echo: ${String(args?.text ?? '')}` }] }
    }
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
  })
  return server
}

const app = createMcpExpressApp()
app.post('/', async (req, res) => {
  const server = getServer()
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    res.on('close', () => {
      transport.close()
      server.close()
    })
  } catch (e) {
    console.error('MCP request error:', (e as Error).message)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  }
})

const httpServer = http.createServer(app)
httpServer.listen(0, () => {
  const port = (httpServer.address() as { port: number }).port
  console.log(port)
})
