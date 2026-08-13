import type { Tool } from '../tools/index.ts'
import type { McpClientManager, RemoteToolInfo } from './manager.ts'

// MCP inputSchema（标准 JSON Schema）→ MeiCode JsonSchema（宽容转换：保留核心字段）
function convertSchema(inputSchema: Record<string, unknown>): { type: 'object'; description?: string; properties?: Record<string, unknown>; required?: string[] } {
  return {
    type: 'object',
    ...(typeof inputSchema.description === 'string' ? { description: inputSchema.description } : {}),
    ...(inputSchema.properties && typeof inputSchema.properties === 'object'
      ? { properties: inputSchema.properties as Record<string, unknown> }
      : {}),
    ...(Array.isArray(inputSchema.required) ? { required: inputSchema.required as string[] } : {}),
  }
}

export function toMewTool(serverName: string, info: RemoteToolInfo, manager: McpClientManager): Tool {
  return {
    name: `${serverName}_${info.name}`,
    description: info.description || `远程工具（MCP Server: ${serverName}）`,
    parameters: convertSchema(info.inputSchema),
    async execute(args) {
      return manager.callTool(serverName, info.name, args)
    },
  }
}
