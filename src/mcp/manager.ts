import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from './config.ts'
import type { ToolResult } from '../tools/index.ts'
import { withIdleTimeout } from '../provider/timeout.ts'

export interface RemoteToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface DiscoverResult {
  ok: string[]
  failed: { name: string; error: string }[]
}

export class McpClientManager {
  private clients = new Map<string, Client>()
  private toolCache = new Map<string, RemoteToolInfo[]>()
  connectCount = 0 // 测试观察用：连接次数
  private servers: McpServerConfig[]

  constructor(servers: McpServerConfig[]) {
    this.servers = servers
  }

  private findServer(name: string): McpServerConfig | undefined {
    return this.servers.find((s) => s.name === name)
  }

  private async connect(server: McpServerConfig): Promise<Client> {
    const client = new Client({ name: 'meicode', version: '0.1.0' }, { capabilities: {} })
    let transport
    if (server.type === 'stdio') {
      const env: Record<string, string> = {}
      if (server.env && Object.keys(server.env).length > 0) {
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) env[k] = v
        }
        Object.assign(env, server.env)
      }
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: Object.keys(env).length > 0 ? env : undefined,
      })
    } else {
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit:
          server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : undefined,
      })
    }
    await client.connect(transport)
    this.connectCount++
    return client
  }

  // 懒发现：已有缓存直接返回；否则连接 + listTools + 缓存
  private async discoverOne(name: string): Promise<{ ok: boolean; error?: string }> {
    if (this.toolCache.has(name)) return { ok: true }
    const server = this.findServer(name)
    if (!server) return { ok: false, error: `未找到 Server: ${name}` }
    try {
      // 超时兜底：connect/listTools 挂起时不阻塞 Agent Loop（callTool 已有 30s 包装）
      const client = await withIdleTimeout(this.connect(server), 15000)
      const { tools } = await withIdleTimeout(client.listTools(), 15000)
      this.clients.set(name, client)
      this.toolCache.set(
        name,
        tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        })),
      )
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async discoverAll(): Promise<DiscoverResult> {
    const results = await Promise.all(this.servers.map((s) => this.discoverOne(s.name)))
    const ok: string[] = []
    const failed: { name: string; error: string }[] = []
    this.servers.forEach((s, i) => {
      if (results[i].ok) ok.push(s.name)
      else failed.push({ name: s.name, error: results[i].error ?? '未知错误' })
    })
    return { ok, failed }
  }

  getTools(serverName: string): RemoteToolInfo[] | undefined {
    return this.toolCache.get(serverName)
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    let client = this.clients.get(serverName)
    if (!client) {
      const server = this.findServer(serverName)
      if (!server) return { success: false, output: '', error: `[MCP 错误] 未找到 Server: ${serverName}` }
      try {
        client = await withIdleTimeout(this.connect(server), 15000)
        this.clients.set(serverName, client)
        await withIdleTimeout(client.listTools(), 15000) // 确保握手完成
      } catch (e) {
        return { success: false, output: '', error: `[MCP 错误] 连接失败: ${(e as Error).message}` }
      }
    }
    try {
      // 30s 超时兜底：MCP Server 挂起时不阻塞 Agent Loop
      const result = await withIdleTimeout(client.callTool({ name: toolName, arguments: args }), 30000)
      return toToolResult(result)
    } catch (e) {
      return { success: false, output: '', error: `[MCP 错误] ${(e as Error).message}` }
    }
  }

  async closeAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close()
      } catch {
        // 关闭失败不阻塞其他
      }
      this.clients.delete(name)
    }
    this.toolCache.clear()
  }
}

function toToolResult(result: unknown): ToolResult {
  const r = result as { content?: unknown; isError?: boolean }
  const content = Array.isArray(r.content)
    ? r.content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
        .join('\n')
    : ''
  if (r.isError) return { success: false, output: content, error: content || 'MCP 工具执行失败' }
  return { success: true, output: content }
}
