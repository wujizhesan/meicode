export interface ProviderConfig {
  name: string
  protocol: 'anthropic' | 'openai'
  model: string
  base_url: string
  api_key: string
  thinking?: boolean
  mcpServers?: Record<string, unknown>
  context_window?: number
}
