// 最小 stdio MCP Server（echo 工具）——测试用
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'mewcode-test-server', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显输入的文本',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '两个数字相加',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: '第一个数' },
          b: { type: 'number', description: '第二个数' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${String(args?.text ?? '')}` }] }
  }
  if (name === 'add') {
    const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0)
    return { content: [{ type: 'text', text: `sum: ${sum}` }] }
  }
  return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
