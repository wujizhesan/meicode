// TUI 冒烟：渲染不崩 + 静态快照包含就绪提示
import { render, renderToString } from 'ink'
import { App } from '../src/tui/App.tsx'
import { History } from '../src/session/history.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { ProviderConfig } from '../src/config/types.ts'
import { createStreamBuffer, streamFlushDelay } from '../src/tui/stream-buffer.ts'
import { ChatView } from '../src/tui/ChatView.tsx'

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

const streamingSnapshot = renderToString(
  <ChatView
    mode="streaming"
    messages={[
      { role: 'assistant', text: '', thinking: '旧思考' },
      { role: 'user', text: '继续' },
      { role: 'assistant', text: '', thinking: '新思考' },
    ]}
  />,
)
if ((streamingSnapshot.match(/▍/g) ?? []).length !== 1 || (streamingSnapshot.match(/…/g) ?? []).length !== 1) {
  throw new Error(`流式光标不应出现在历史消息: ${JSON.stringify(streamingSnapshot)}`)
}
console.log('  ✓ 流式光标仅标记当前助手消息')

const longMessages = Array.from({ length: 205 }, (_, index) => ({
  role: 'user' as const,
  text: `历史消息-${index}`,
}))
const foldedSnapshot = renderToString(<ChatView mode="streaming" messages={longMessages} />)
if (foldedSnapshot.includes('历史消息-0') || !foldedSnapshot.includes('历史消息-204') || !foldedSnapshot.includes('暂时折叠前 5 条消息')) {
  throw new Error('长历史在流式输出期间未正确折叠')
}
const restoredSnapshot = renderToString(<ChatView mode="idle" messages={longMessages} />)
if (!restoredSnapshot.includes('历史消息-0') || restoredSnapshot.includes('暂时折叠')) {
  throw new Error('流式输出结束后未恢复完整历史')
}
console.log('  ✓ 长历史仅在流式输出期间折叠并在结束后恢复')

const typingSnapshot = renderToString(<ChatView mode="idle" compact messages={longMessages} />)
if (typingSnapshot.includes('历史消息-0') || !typingSnapshot.includes('历史消息-204') || !typingSnapshot.includes('输入期间暂时折叠前 5 条消息')) {
  throw new Error('长历史在编辑输入时未正确折叠')
}
console.log('  ✓ 长历史仅在编辑输入时临时折叠')

const largeMessages = Array.from({ length: 18 }, (_, index) => ({
  role: 'assistant' as const,
  text: `长消息-${index}-${'x'.repeat(3000)}`,
}))
const sizeLimitedSnapshot = renderToString(<ChatView mode="streaming" messages={largeMessages} />)
if (sizeLimitedSnapshot.includes('长消息-0-') || !sizeLimitedSnapshot.includes('长消息-17-') || !sizeLimitedSnapshot.includes('暂时折叠前')) {
  throw new Error('流式长文本未按字符预算折叠')
}
console.log('  ✓ 流式长文本按字符预算折叠并保留最新消息')

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

if (
  streamFlushDelay(0) !== 16
  || streamFlushDelay(50) !== 24
  || streamFlushDelay(200) !== 32
  || streamFlushDelay(500) !== 50
  || streamFlushDelay(1000) !== 80
) {
  throw new Error('流式刷新间隔未按历史长度调整')
}
console.log('  ✓ 长历史自适应降低刷新频率')

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
