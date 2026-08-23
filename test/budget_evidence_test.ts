import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ContextManager } from '../src/context/index.ts'
import { History } from '../src/session/history.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import { editFileTool } from '../src/tools/edit_file.ts'
import { readFileTool } from '../src/tools/read_file.ts'
import { runCommandTool } from '../src/tools/run_command.ts'
import { writeFileTool } from '../src/tools/write_file.ts'
import type { ToolContext } from '../src/tools/index.ts'

class FakeProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: 'ok' }
    yield { type: 'done' }
  }
}

const root = join(import.meta.dirname, 'fixtures_budget_evidence')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const history = new History()
history.push({ role: 'user', content: 'x'.repeat(400) })
const manager = new ContextManager({ provider: new FakeProvider(), history, cwd: root, window: 1000 })
const initial = manager.snapshot()
if (initial.estimatedTokens <= 0 || initial.remainingTokens >= initial.window) throw new Error('预算快照错误')
manager.afterRequest(123, 1)
if (manager.snapshot().lastInputTokens !== 123) throw new Error('usage 未进入预算快照')

const ctx: ToolContext = { cwd: root }
const file = join(root, 'sample.txt')
const write = await writeFileTool.execute({ path: file, content: 'hello world' }, ctx)
if (!write.success || !write.evidence?.changedFiles?.includes(file)) throw new Error('写文件证据缺失')
const read = await readFileTool.execute({ path: file }, ctx)
if (!read.success || !read.evidence?.files?.includes(file)) throw new Error('读文件证据缺失')
const edit = await editFileTool.execute({ path: file, old_text: 'world', new_text: 'meicode' }, ctx)
if (!edit.success || !edit.evidence?.changedFiles?.includes(file)) throw new Error('编辑文件证据缺失')
const command = await runCommandTool.execute({ command: 'node', args: ['--version'] }, ctx)
if (!command.success || command.evidence?.exitCode !== 0 || !command.evidence.commands?.length) throw new Error('命令证据缺失')

rmSync(root, { recursive: true, force: true })
console.log('budget_evidence_test passed')
