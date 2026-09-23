export type McpServerConfig =
  | { name: string; type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: 'http'; url: string; headers?: Record<string, string> }

// ${VAR} → process.env；缺失保留原样
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const v = process.env[name]
    if (v === undefined) return match
    return v
  })
}

export function parseMcpServers(
  ...layers: unknown[]
): { servers: McpServerConfig[]; skipped: string[] } {
  // 兼容两种声明格式：
  //  map:   { name: { type, command, args, env, url, headers } }
  //  数组:  [{ name, type?, command, args, ... }]（type 缺省按 command/url 推断）
  const merged: Record<string, Record<string, unknown>> = {}

  const absorb = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === 'object') {
          const entry = item as Record<string, unknown>
          const name = String(entry.name ?? '')
          if (name) merged[name] = { ...(merged[name] ?? {}), ...entry }
        }
      }
    } else {
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          merged[name] = { ...(merged[name] ?? {}), ...(value as Record<string, unknown>) }
        }
      }
    }
  }
  for (const layer of layers) absorb(layer)

  const servers: McpServerConfig[] = []
  const skipped: string[] = []
  for (const [name, cfg] of Object.entries(merged)) {
    // type 缺省推断：有 command → stdio；有 url → http
    const type = cfg.type ?? (typeof cfg.command === 'string' ? 'stdio' : typeof cfg.url === 'string' ? 'http' : undefined)
    if (type === 'stdio' && typeof cfg.command === 'string') {
      const env: Record<string, string> = {}
      if (cfg.env && typeof cfg.env === 'object') {
        for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
          env[k] = expandEnv(String(v))
        }
      }
      servers.push({
        name,
        type: 'stdio',
        command: expandEnv(cfg.command),
        args: Array.isArray(cfg.args) ? cfg.args.map((a) => expandEnv(String(a))) : undefined,
        env,
      })
    } else if (type === 'http' && typeof cfg.url === 'string') {
      const headers: Record<string, string> = {}
      if (cfg.headers && typeof cfg.headers === 'object') {
        for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
          headers[k] = expandEnv(String(v))
        }
      }
      servers.push({ name, type: 'http', url: expandEnv(cfg.url), headers })
    } else {
      skipped.push(`${name}（缺 type/command/url，已跳过）`)
    }
  }

  return { servers, skipped }
}
