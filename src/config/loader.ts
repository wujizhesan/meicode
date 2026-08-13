import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { ProviderConfig } from './types.ts'
import { loadModelCatalog, resolveCatalogEndpoint } from './model-catalog.ts'
import { parseMcpServers } from '../mcp/config.ts'
import type { McpServerConfig } from '../mcp/config.ts'

const REQUIRED_FIELDS = ['name', 'protocol', 'model', 'base_url', 'api_key'] as const

export function loadConfig(path?: string): ProviderConfig {
  const file = path ?? join(homedir(), '.mewcode', 'config.yaml')

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`配置文件不存在: ${file}`)
  }

  let data: Record<string, unknown>
  try {
    const parsed = parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('配置内容为空或不是对象')
    }
    data = parsed as Record<string, unknown>
  } catch (e) {
    throw new Error(`YAML 解析失败: ${(e as Error).message}`)
  }

  // 模型目录模式: config 写 provider: <id> 一行,protocol/model/base_url 从目录取
  // (api_key 仍必填;provider 模式下可省略 protocol/model/base_url)
  const catalog = loadModelCatalog()
  const providerId = typeof data.provider === 'string' && data.provider ? data.provider : undefined
  const catProvider = providerId ? catalog.providers.find((p) => p.id === providerId) : undefined
  if (providerId && !catProvider) {
    throw new Error(`模型目录中无 provider: ${providerId}（可编辑 ~/.mewcode/model-providers.json 扩展）`)
  }
  if (catProvider) {
    const kind = (data.protocol === 'openai' ? 'openai' : catProvider.defaultKind) as 'anthropic' | 'openai'
    const endpoint = resolveCatalogEndpoint(catalog, catProvider.id, kind)
    if (endpoint) {
      data.protocol = kind
      data.base_url = endpoint
      if (typeof data.model !== 'string' || !data.model) {
        data.model = catProvider.models[0]?.id ?? ''
      }
      if (!data.name) data.name = catProvider.name
    }
  }

  if (!catProvider) {
    for (const field of REQUIRED_FIELDS) {
      const v = data[field]
      if (v === undefined || v === null || v === '') {
        throw new Error(`配置字段缺失或为空: ${field}`)
      }
    }
  } else if (typeof data.api_key !== 'string' || !data.api_key) {
    throw new Error('配置字段缺失或为空: api_key（模型目录不含密钥,需在 config 填）')
  }

  if (data.protocol !== 'anthropic' && data.protocol !== 'openai') {
    throw new Error(`不支持的 protocol: ${String(data.protocol)}（可选 anthropic / openai）`)
  }

  return data as unknown as ProviderConfig
}

export interface LoadedConfig {
  provider: ProviderConfig
  mcpServers: McpServerConfig[]
  mcpSkipped: string[]
}

// 加载主配置 + 合并用户级/项目级 MCP Server 列表
export function loadConfigWithMcp(path?: string): LoadedConfig {
  const provider = loadConfig(path)
  const userCfg = readOptionalYaml(join(homedir(), '.mewcode', 'config.yaml'))
  const projectCfg = readOptionalYaml(join(process.cwd(), '.mewcode', 'config.yaml'))
  const userRaw = (userCfg as Record<string, unknown> | null) ?? {}
  const projectRaw = (projectCfg as Record<string, unknown> | null) ?? {}
  const { servers, skipped } = parseMcpServers(
    userRaw.mcpServers ?? userRaw.mcp_servers,
    projectRaw.mcpServers ?? projectRaw.mcp_servers,
  )
  return { provider, mcpServers: servers, mcpSkipped: skipped }
}

function readOptionalYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
