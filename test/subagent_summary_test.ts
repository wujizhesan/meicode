import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SubAgentManager } from '../src/subagent/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'

class CountingProvider implements Provider {
  readonly protocol = 'openai' as const
  calls = 0

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.calls++
    yield { type: 'text', text: '子任务输出' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_subagent_summary')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const provider = new CountingProvider()
const manager = new SubAgentManager({ builtin: root, user: root, project: root })
const result = await manager.spawn({ type: 'fork', prompt: '执行简单任务' }, { provider, registry: { toOpenAITools: () => [] } as never, ctx: { cwd: root } })
if (!result.async) throw new Error('fork 应后台执行')
await new Promise((resolve) => setTimeout(resolve, 250))
const record = manager.getRecord(result.id)
if (provider.calls !== 1) throw new Error(`不应发起二次摘要请求: ${provider.calls}`)
if (!record?.reportId || record.result !== '子任务输出') throw new Error('本地摘要或报告 ID 缺失')

rmSync(root, { recursive: true, force: true })
console.log('subagent_summary_test passed')
