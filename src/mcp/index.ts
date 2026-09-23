import type { ToolRegistry } from '../tools/index.ts'
import type { McpClientManager } from './manager.ts'
import { toMewTool } from './adapter.ts'

export interface McpRegisterResult {
  ok: string[]
  failed: { name: string; error: string }[]
  toolCount: number
  registered: string[]
}

export interface McpToolRegistrar {
  readonly ready: boolean
  discover(): Promise<McpRegisterResult>
}

export async function registerMcpTools(
  registry: ToolRegistry,
  manager: McpClientManager,
  registeredServers = new Set<string>(),
): Promise<McpRegisterResult> {
  const { ok, failed } = await manager.discoverAll()
  let toolCount = 0
  const registered: string[] = []
  for (const serverName of ok) {
    if (registeredServers.has(serverName)) continue
    const tools = manager.getTools(serverName) ?? []
    for (const info of tools) {
      try {
        registry.register(toMewTool(serverName, info, manager))
        toolCount++
      } catch {
        // 重名等注册失败跳过
      }
    }
    registeredServers.add(serverName)
    registered.push(serverName)
  }
  return { ok, failed, toolCount, registered }
}

export function createMcpToolRegistrar(registry: ToolRegistry, manager: McpClientManager): McpToolRegistrar {
  const registeredServers = new Set<string>()
  let ready = false
  return {
    get ready() {
      return ready
    },
    async discover() {
      const result = await registerMcpTools(registry, manager, registeredServers)
      ready = result.failed.length === 0
      return result
    },
  }
}

export { McpClientManager, type RemoteToolInfo, type DiscoverResult } from './manager.ts'
export { parseMcpServers, expandEnv, type McpServerConfig } from './config.ts'
