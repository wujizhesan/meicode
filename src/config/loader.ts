import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import type { ProviderConfig } from './types.ts'
import { loadModelCatalog, resolveCatalogEndpoint } from './model-catalog.ts'
import { parseMcpServers } from '../mcp/config.ts'
import type { McpServerConfig } from '../mcp/config.ts'
import { parseA2aAgents } from '../a2a/config.ts'
import type { A2aAgentConfig } from '../a2a/config.ts'
import { projectStatePath, userStatePath } from '../state-paths.ts'

const REQUIRED_FIELDS = ['name', 'protocol', 'model', 'base_url', 'api_key'] as const
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function loadConfig(path?: string): ProviderConfig {
  const file = path ?? userStatePath('config.yaml')
  return parseProvider(readRequiredYaml(file))
}

function readRequiredYaml(file: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`配置文件不存在: ${file}`)
  }

  try {
    const parsed = parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('配置内容为空或不是对象')
    }
    return parsed as Record<string, unknown>
  } catch (e) {
    throw new Error(`YAML 解析失败: ${(e as Error).message}`)
  }
}

function parseProvider(raw: Record<string, unknown>): ProviderConfig {
  const data = { ...raw }
  const envField = typeof data.api_key_env === 'string' ? data.api_key_env.trim() : ''
  const inlineEnv = typeof data.api_key === 'string' ? data.api_key.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] : undefined
  const envName = envField || inlineEnv
  if (envName) {
    if (!ENV_NAME_RE.test(envName)) throw new Error(`api_key_env 不是合法环境变量名: ${envName}`)
    const value = process.env[envName]
    if (!value) throw new Error(`环境变量未设置或为空: ${envName}`)
    data.api_key = value
  }
  if (data.protocol !== undefined && data.protocol !== 'anthropic' && data.protocol !== 'openai') {
    throw new Error(`不支持的 protocol: ${String(data.protocol)}（可选 anthropic / openai）`)
  }
  // 模型目录模式: config 写 provider: <id> 一行,protocol/model/base_url 从目录取
  // (api_key 仍必填;provider 模式下可省略 protocol/model/base_url)
  const catalog = loadModelCatalog()
  const providerId = typeof data.provider === 'string' && data.provider ? data.provider : undefined
  const catProvider = providerId ? catalog.providers.find((p) => p.id === providerId) : undefined
  if (providerId && !catProvider) {
    throw new Error(`模型目录中无 provider: ${providerId}（可编辑 ~/.meicode/model-providers.json 扩展）`)
  }
  if (catProvider) {
    const kind = (data.protocol ?? catProvider.defaultKind) as 'anthropic' | 'openai'
    const endpoint = resolveCatalogEndpoint(catalog, catProvider.id, kind)
    if (!endpoint) throw new Error(`provider ${catProvider.id} 不支持 ${kind} 协议`)
    data.protocol = kind
    data.base_url = endpoint
    if (typeof data.model !== 'string' || !data.model) data.model = catProvider.models[0]?.id ?? ''
    if (!data.name) data.name = catProvider.name
    const catalogModel = catProvider.models.find((model) => model.id === data.model)
    if (catalogModel && !catalogModel.kinds.includes(kind)) {
      throw new Error(`模型 ${catalogModel.id} 不支持 ${kind} 协议`)
    }
    if (catalogModel?.contextWindow && data.context_window === undefined) data.context_window = catalogModel.contextWindow
    if (catalogModel?.maxOutputTokens && data.max_output_tokens === undefined) data.max_output_tokens = catalogModel.maxOutputTokens
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

  if (data.protocol !== 'anthropic' && data.protocol !== 'openai') throw new Error(`不支持的 protocol: ${String(data.protocol)}（可选 anthropic / openai）`)
  if (data.context_window !== undefined && (typeof data.context_window !== 'number' || !Number.isInteger(data.context_window) || data.context_window <= 0)) {
    throw new Error('context_window 必须是正整数')
  }
  if (data.max_output_tokens !== undefined && (typeof data.max_output_tokens !== 'number' || !Number.isInteger(data.max_output_tokens) || data.max_output_tokens <= 1)) {
    throw new Error('max_output_tokens 必须是大于 1 的整数')
  }

  return data as unknown as ProviderConfig
}

export interface LoadedConfig {
  provider: ProviderConfig
  mcpServers: McpServerConfig[]
  mcpSkipped: string[]
  a2aAgents: A2aAgentConfig[]
  a2aSkipped: string[]
}

// 加载主配置 + 合并用户级/项目级 MCP Server 列表
export function loadConfigWithMcp(path?: string): LoadedConfig {
  const userFile = userStatePath('config.yaml')
  const projectFile = projectStatePath(process.cwd(), 'config.yaml')
  const providerFile = path ?? userFile
  const providerRaw = readRequiredYaml(providerFile)
  const provider = parseProvider(providerRaw)
  const userCfg = samePath(providerFile, userFile) ? providerRaw : readOptionalYaml(userFile)
  const projectCfg = samePath(providerFile, projectFile) ? providerRaw : readOptionalYaml(projectFile)
  const userRaw = (userCfg as Record<string, unknown> | null) ?? {}
  const projectRaw = (projectCfg as Record<string, unknown> | null) ?? {}
  const explicitRaw = samePath(providerFile, userFile) || samePath(providerFile, projectFile) ? {} : providerRaw
  const { servers, skipped } = parseMcpServers(
    userRaw.mcpServers ?? userRaw.mcp_servers,
    projectRaw.mcpServers ?? projectRaw.mcp_servers,
    explicitRaw.mcpServers ?? explicitRaw.mcp_servers,
  )
  const a2a = parseA2aAgents(
    userRaw.a2aAgents ?? userRaw.a2a_agents,
    projectRaw.a2aAgents ?? projectRaw.a2a_agents,
    explicitRaw.a2aAgents ?? explicitRaw.a2a_agents,
  )
  return { provider, mcpServers: servers, mcpSkipped: skipped, a2aAgents: a2a.agents, a2aSkipped: a2a.skipped }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function readOptionalYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
