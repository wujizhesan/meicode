import type { ProviderConfig } from '../config/types.ts'
import type { Provider } from './types.ts'
import { AnthropicProvider } from './anthropic.ts'
import { OpenAIProvider } from './openai.ts'

export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.protocol) {
    case 'anthropic':
      return new AnthropicProvider(cfg)
    case 'openai':
      return new OpenAIProvider(cfg)
    default:
      throw new Error(`不支持的 protocol: ${cfg.protocol}`)
  }
}
