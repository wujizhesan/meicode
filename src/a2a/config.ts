import { expandEnv } from '../mcp/config.ts'

export interface A2aAgentConfig {
  name: string
  url: string
  token?: string
  binding?: 'http' | 'jsonrpc'
}

export function parseA2aAgents(...layers: unknown[]): { agents: A2aAgentConfig[]; skipped: string[] } {
  const merged: Record<string, Record<string, unknown>> = {}

  const absorb = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        const name = String(entry.name ?? '')
        if (name) merged[name] = { ...(merged[name] ?? {}), ...entry }
      }
      return
    }
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) merged[name] = { ...(merged[name] ?? {}), ...(value as Record<string, unknown>) }
    }
  }

  for (const layer of layers) absorb(layer)
  const agents: A2aAgentConfig[] = []
  const skipped: string[] = []
  for (const [name, cfg] of Object.entries(merged)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || typeof cfg.url !== 'string') {
      skipped.push(`${name}（缺少合法 name/url）`)
      continue
    }
    let parsed: URL
    try {
      parsed = new URL(expandEnv(cfg.url))
    } catch {
      skipped.push(`${name}（url 无效）`)
      continue
    }
    if (parsed.username || parsed.password || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      skipped.push(`${name}（仅支持 http/https 且禁止 URL 凭据）`)
      continue
    }
    const binding = cfg.binding === undefined ? 'http' : cfg.binding
    if (binding !== 'http' && binding !== 'jsonrpc') {
      skipped.push(`${name}（binding 无效）`)
      continue
    }
    const token = cfg.token === undefined ? undefined : expandEnv(String(cfg.token))
    if (token && (token.length > 1024 || /[\r\n]/.test(token))) {
      skipped.push(`${name}（token 无效）`)
      continue
    }
    agents.push({ name, url: parsed.toString().replace(/\/$/, ''), ...(token ? { token } : {}), binding })
  }
  return { agents, skipped }
}
