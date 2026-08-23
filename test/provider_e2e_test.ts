import { createProvider } from '../src/provider/index.ts'
import { loadConfig } from '../src/config/loader.ts'

if (process.env.MEICODE_REAL_PROVIDER !== '1') {
  console.log('provider_e2e_test skipped (set MEICODE_REAL_PROVIDER=1 to enable)')
} else {
  const configPath = process.env.MEICODE_PROVIDER_CONFIG
  if (!configPath) throw new Error('MEICODE_PROVIDER_CONFIG 未设置')
  const provider = createProvider(loadConfig(configPath))
  const events = []
  for await (const event of provider.streamChat([{ role: 'user', content: 'Reply with exactly OK.' }], {})) events.push(event)
  const errors = events.filter((event) => event.type === 'error')
  if (errors.length > 0) throw new Error(`真实 Provider 返回错误: ${errors.map((event) => event.message).join('; ')}`)
  if (!events.some((event) => event.type === 'text') || !events.some((event) => event.type === 'done')) throw new Error('真实 Provider 未返回完整文本流')
  console.log(`provider_e2e_test passed (${provider.protocol})`)
}
