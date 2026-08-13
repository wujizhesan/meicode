import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 模型目录 schema(对齐 Zcode model-providers.v1):
// provider 级 = 端点(baseURL + 各协议路径)+ 默认协议
// 模型级 = id/kinds(支持的协议)/上下文/输出上限
// config.yaml 用 provider: <id> 一行切换,不用手改 base_url/protocol

export interface CatalogModel {
  id: string
  name?: string
  kinds: ('anthropic' | 'openai')[]
  contextWindow?: number
  maxOutputTokens?: number
}

export interface CatalogProvider {
  id: string
  name: string
  baseURL: string
  paths: { anthropic?: string; openai?: string }
  defaultKind: 'anthropic' | 'openai'
  models: CatalogModel[]
}

export interface ModelCatalog {
  schemaVersion: string
  providers: CatalogProvider[]
}

// 内置目录(端点来自 Zcode models_catalog_china_llm 2026-06,已实测通用)
const BUILTIN: ModelCatalog = {
  schemaVersion: 'meicode.model-providers.v1',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      paths: { anthropic: '/anthropic/v1/messages', openai: '/chat/completions' },
      defaultKind: 'anthropic',
      models: [
        { id: 'deepseek-v4-flash', kinds: ['anthropic', 'openai'], contextWindow: 1000000, maxOutputTokens: 384000 },
        { id: 'deepseek-v4-pro', kinds: ['anthropic', 'openai'], contextWindow: 1000000, maxOutputTokens: 384000 },
      ],
    },
    {
      id: 'kimi',
      name: 'Moonshot AI / Kimi',
      baseURL: 'https://api.moonshot.cn',
      paths: { anthropic: '/anthropic/v1/messages', openai: '/v1/chat/completions' },
      defaultKind: 'anthropic',
      models: [
        { id: 'kimi-k3', kinds: ['anthropic', 'openai'], contextWindow: 1048576, maxOutputTokens: 131072 },
        { id: 'k3', kinds: ['anthropic', 'openai'], contextWindow: 1048576, maxOutputTokens: 131072 },
      ],
    },
    {
      id: 'qwen',
      name: '通义千问 (Model Studio)',
      baseURL: 'https://dashscope.aliyuncs.com',
      paths: { anthropic: '/apps/anthropic/v1/messages', openai: '/compatible-mode/v1/chat/completions' },
      defaultKind: 'anthropic',
      models: [
        { id: 'qwen3.5-plus', kinds: ['anthropic', 'openai'], contextWindow: 1000000, maxOutputTokens: 65536 },
        { id: 'qwen3.5-flash', kinds: ['anthropic', 'openai'], contextWindow: 1000000, maxOutputTokens: 65536 },
      ],
    },
    {
      id: 'bigmodel',
      name: '智谱 GLM',
      baseURL: 'https://open.bigmodel.cn',
      paths: { anthropic: '/api/anthropic/v1/messages' },
      defaultKind: 'anthropic',
      models: [
        { id: 'glm-5.1', kinds: ['anthropic'], contextWindow: 200000, maxOutputTokens: 64000 },
        { id: 'glm-5', kinds: ['anthropic'], contextWindow: 200000, maxOutputTokens: 64000 },
      ],
    },
    {
      id: 'mimo',
      name: '小米 MiMo',
      baseURL: 'https://api.xiaomimimo.com',
      paths: { anthropic: '/anthropic/v1/messages', openai: '/v1/chat/completions' },
      defaultKind: 'anthropic',
      models: [
        { id: 'mimo-v2.5-pro', kinds: ['anthropic', 'openai'], contextWindow: 1000000, maxOutputTokens: 131072 },
        { id: 'mimo-v2.5', kinds: ['anthropic', 'openai'], contextWindow: 1000000, maxOutputTokens: 131072 },
      ],
    },
  ],
}

// 用户覆盖/扩展: ~/.mewcode/model-providers.json(同 schema,merge by provider id)
export function loadModelCatalog(): ModelCatalog {
  const userFile = join(homedir(), '.mewcode', 'model-providers.json')
  if (!existsSync(userFile)) return BUILTIN
  try {
    const user = JSON.parse(readFileSync(userFile, 'utf8')) as ModelCatalog
    if (!Array.isArray(user.providers)) return BUILTIN
    const providers = new Map(BUILTIN.providers.map((p) => [p.id, p]))
    for (const p of user.providers) {
      if (!p?.id) continue
      providers.set(p.id, { ...providers.get(p.id), ...p }) // 用户覆盖同 id,新增扩展
    }
    return { schemaVersion: user.schemaVersion ?? BUILTIN.schemaVersion, providers: [...providers.values()] }
  } catch {
    return BUILTIN
  }
}

// 按 provider id + 协议取完整端点(baseURL + 路径拼接)
export function resolveCatalogEndpoint(catalog: ModelCatalog, providerId: string, kind: 'anthropic' | 'openai'): string | null {
  const p = catalog.providers.find((x) => x.id === providerId)
  if (!p) return null
  const path = kind === 'anthropic' ? p.paths.anthropic : p.paths.openai
  if (!path) return null
  return `${p.baseURL.replace(/\/+$/, '')}${path}`
}
