// TUI 冒烟：渲染不崩 + 静态快照包含就绪提示
import { render, renderToString } from 'ink'
import { App } from '../src/tui/App.tsx'
import { History } from '../src/session/history.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { ProviderConfig } from '../src/config/types.ts'
import { createStreamBuffer } from '../src/tui/stream-buffer.ts'

class FakeProvider implements Provider {
  readonly protocol = 'anthropic' as const
  async *streamChat(messages: ChatMessage[], _opts: { thinking?: boolean }): AsyncGenerator<StreamEvent> {
    for (const ch of '你好，世界！') {
      yield { type: 'text', text: ch }
      await new Promise((r) => setTimeout(r, 10))
    }
    yield { type: 'done' }
  }
}

const cfg: ProviderConfig = { name: 't', protocol: 'anthropic', model: 'm', base_url: 'http://x', api_key: 'k' }

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  createTools({ cwd: process.cwd() }).forEach((t) => r.register(t))
  return r
}

function makeEngine(): RuleEngine {
  const e = new RuleEngine('', '', '')
  return e
}

const snapshot = renderToString(<App provider={new FakeProvider()} history={new History()} registry={makeRegistry()} engine={makeEngine()} />)
if (!snapshot.includes('MeiCode 就绪')) {
  console.error('快照缺少就绪提示:', JSON.stringify(snapshot))
  process.exit(1)
}
console.log('  ✓ renderToString 快照含就绪提示')

const batches: { text: string; thinking: string }[] = []
const streamBuffer = createStreamBuffer((chunk) => batches.push(chunk), 10)
streamBuffer.appendText('你')
streamBuffer.appendText('好')
streamBuffer.appendThinking('思')
await new Promise((resolve) => setTimeout(resolve, 20))
if (batches.length !== 1 || batches[0].text !== '你好' || batches[0].thinking !== '思') {
  throw new Error(`流式缓冲合并失败: ${JSON.stringify(batches)}`)
}
streamBuffer.dispose()
console.log('  ✓ 流式片段按帧合并刷新')

if (process.stdin.isTTY) {
  const app = render(<App provider={new FakeProvider()} history={new History()} registry={makeRegistry()} engine={makeEngine()} />)
  setTimeout(() => {
    app.unmount()
    console.log('  ✓ render 挂载 1.5s 未崩溃')
    console.log('\nTUI smoke passed')
    process.exit(0)
  }, 1500)
} else {
  console.log('  - 非 TTY：跳过挂载测试（Ink 需真实终端），TTY 下由 cli 冒烟覆盖')
  console.log('\nTUI smoke passed')
  process.exit(0)
}
