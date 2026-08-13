import type { ToolRegistry } from '../tools/index.ts'
import type { McpClientManager } from './manager.ts'
import { toMewTool } from './adapter.ts'

export interface McpRegisterResult {
  ok: string[]
  failed: { name: string; error: string }[]
  toolCount: number
}

// 发现并注册全部远端工具（懒连接；单 Server 失败不影响其他）
export async function registerMcpTools(registry: ToolRegistry, manager: McpClientManager): Promise<McpRegisterResult> {
  const { ok, failed } = await manager.discoverAll()
  let toolCount = 0
  for (const serverName of ok) {
    const tools = manager.getTools(serverName) ?? []
    for (const info of tools) {
      try {
        registry.register(toMewTool(serverName, info, manager))
        toolCount++
      } catch {
        // 重名等注册失败跳过
      }
    }
  }
  return { ok, failed, toolCount }
}

export { McpClientManager, type RemoteToolInfo, type DiscoverResult } from './manager.ts'
export { parseMcpServers, expandEnv, type McpServerConfig } from './config.ts'
