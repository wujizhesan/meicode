import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { TokenEstimator } from '../src/context/estimate.ts'
import { ContextManager } from '../src/context/manager.ts'
import { SUMMARY_SYSTEM, tailKeep } from '../src/context/summary.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamMail } from '../src/team/mail.ts'
import { MemberHost } from '../src/team/member.ts'
import type { TeamMember } from '../src/team/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function recentMessages(count: number, chars = 400): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}:` + 'x'.repeat(chars - `${index}:`.length),
  }))
}

function toolGroup(lines = 2000, name = 'write_file'): ChatMessage[] {
  const content = Array.from({ length: lines }, (_, index) => `export const item_${index} = ${index};`).join('\n')
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: 'write-1', name, arguments: JSON.stringify({ path: 'generated.ts', content }) }] },
    { role: 'tool', tool_call_id: 'write-1', content: 'OK' },
  ]
}

class CapturingProvider implements Provider {
  readonly protocol = 'openai' as const
  summaries: ChatMessage[][] = []
  requests: ChatMessage[][] = []

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    if (messages[0]?.content === SUMMARY_SYSTEM) {
      this.summaries.push(messages)
      yield { type: 'text', text: '本地工具历史摘要' }
    } else {
      this.requests.push(messages)
      yield { type: 'text', text: '成员任务完成' }
    }
    yield { type: 'done' }
  }
}

await check('全量估算包含并行 write_file/edit_file 参数、名称和调用 ID，保持原文', () => {
  const write = toolGroup()[0].tool_calls![0]
  const edit = { ...toolGroup(1500, 'edit_file')[0].tool_calls![0], id: 'edit-1' }
  const messages: ChatMessage[] = [
    { role: 'assistant', content: '', tool_calls: [write, edit] },
    { role: 'tool', content: 'OK', tool_call_id: edit.id },
    { role: 'tool', content: 'OK', tool_call_id: write.id },
  ]
  const original = JSON.stringify(messages)
  const estimator = new TokenEstimator()
  assert(estimator.estimate(messages) > (write.arguments.length + edit.arguments.length) / 4)
  assert.equal(estimator.estimate([{ role: 'user', content: 'x'.repeat(800) }]), 200)
  assert.equal(estimator.estimate([
    { role: 'assistant', content: 'text', tool_calls: [{ id: 'abcd', name: 'tool', arguments: '12345678' }] },
    { role: 'tool', content: 'done', tool_call_id: 'abcd' },
  ]), 7)
  assert.equal(JSON.stringify(messages), original)
})

await check('API usage 锚点不重复计算旧工具参数，新增调用和结果计入增量', () => {
  const estimator = new TokenEstimator()
  const previous = toolGroup()
  estimator.update(1000, previous.length)
  assert.equal(estimator.estimate(previous), 1000)
  const next = toolGroup(1000, 'edit_file')
  next[0].tool_calls![0].id = 'edit-1'
  next[1].tool_call_id = 'edit-1'
  const total = estimator.estimate([...previous, ...next])
  const argumentsLength = next[0].tool_calls![0].arguments.length
  assert(total > 1000 + argumentsLength / 4)
  assert(total < 1000 + argumentsLength / 4 + 20)
  estimator.update(9000, previous.length + next.length)
  assert.equal(estimator.estimate([...previous, ...next]), 9000)
})

for (const anchored of [false, true]) {
  for (const mode of ['auto', 'manual'] as const) {
    await check(`8K ${mode} 压缩${anchored ? '锚点后新增' : '完整历史中'}的大参数工具组并保留近期消息`, async () => {
      const provider = new CapturingProvider()
      const history = new History()
      history.push({ role: 'user', content: '生成文件' })
      const manager = new ContextManager({ provider, history, cwd: process.cwd(), window: 8192 })
      if (anchored) manager.afterRequest(500, history.length)
      const group = toolGroup()
      const recent = recentMessages(10)
      for (const message of [...group, ...recent]) history.push(message)
      const argumentsText = group[0].tool_calls![0].arguments
      const before = manager.snapshot()
      assert(before.estimatedTokens > 8192)
      assert.equal(before.remainingTokens, 0)
      if (mode === 'auto') await manager.beforeRequest(mode)
      else assert.equal((await manager.compact()).status, 'compacted')
      assert.equal(provider.summaries.length, 1)
      assert.deepEqual(provider.summaries[0].slice(2, 4), group)
      assert.equal(provider.summaries[0][2].tool_calls![0].arguments, argumentsText)
      assert.deepEqual(history.view().slice(2), recent.slice(-9))
      assert.match(history.view()[0].content, /早期对话摘要/)
      assert(manager.snapshot().estimatedTokens < 8192 - before.autoMargin)
      await manager.beforeRequest('auto')
      assert.deepEqual(await manager.compact(), { status: 'skipped', reason: 'below_threshold' })
      assert.equal(provider.summaries.length, 1)
    })
  }
}

await check('尾部参数达到预算后停止保留更早消息，保留完整单个和并行工具组', () => {
  for (const parallel of [false, true]) {
    const prefix = recentMessages(6)
    const group = toolGroup()
    if (parallel) {
      group[0].tool_calls!.push({ ...group[0].tool_calls![0], id: 'edit-1', name: 'edit_file' })
      group.push({ role: 'tool', content: 'OK', tool_call_id: 'edit-1' })
    }
    const tail = recentMessages(parallel ? 2 : 3)
    const messages = [...prefix, ...group, ...tail]
    const original = JSON.stringify(messages)
    const { keep, drop } = tailKeep(messages, 800, 5)
    assert.deepEqual(drop, prefix)
    assert.deepEqual(keep, [...group, ...tail])
    assert.equal(keep.length, 5)
    assert.equal(JSON.stringify(messages), original)
  }
})

for (const scenario of ['arguments', 'prefix', 'below'] as const) {
  const largeArguments = scenario === 'arguments'
  const needsSummary = scenario !== 'below'
  await check(`团队成员${largeArguments ? '因工具参数超预算进行摘要并持久化' : scenario === 'prefix' ? '正文达20K且提示额外占预算时摘要' : '完整请求未达20K时保持历史'}，后续任务正常执行`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'meicode-tool-budget-'))
    const provider = new CapturingProvider()
    const historyFile = join(root, 'member.jsonl')
    const store = new TeamGroupStore(join(root, 'team'))
    const group = store.createGroup('budget', 'lead')
    const record: TeamMember = {
      name: 'worker', role: 'worker', workdir: root, backend: 'coroutine', needsApproval: false, status: 'idle',
    }
    store.addMember(group, record)
    const member = new MemberHost(record, 'budget', {
      provider,
      registry: new ToolRegistry(),
      ctx: { cwd: root },
      historyFile,
      store,
      mail: new TeamMail(join(root, 'mail')),
    })
    try {
      const group = largeArguments ? toolGroup(3000) : []
      const recent = recentMessages(10, largeArguments ? 4000 : scenario === 'prefix' ? 8000 : 7000)
      const task = '继续任务'
      if (scenario === 'prefix') recent.at(-1)!.content = recent.at(-1)!.content.slice(0, -task.length)
      const original = [...group, ...recent]
      assert(original.reduce((sum, message) => sum + message.content.length, 0) <= 80000)
      if (scenario === 'prefix') assert.equal(original.reduce((sum, message) => sum + message.content.length, 0) + task.length, 80000)
      for (const message of original) member.history.push(message)
      const result = await member.execute(task, 'task-budget')
      assert.equal(result.status, 'done')
      assert.equal(result.text, '成员任务完成')
      assert.equal(provider.summaries.length, needsSummary ? 1 : 0)
      assert.equal(provider.requests.length, 1)
      if (largeArguments) {
        assert.deepEqual(provider.summaries[0].slice(1), group)
        assert.deepEqual(member.history.view().slice(2, 12), recent)
        assert(!provider.requests[0].some((message) => message.tool_calls?.length))
      } else if (needsSummary) {
        assert(provider.summaries[0].some((message) => message.content === original[0].content))
        assert(!member.history.view().some((message) => message.content === original[0].content))
        assert.deepEqual(member.history.view().slice(-6, -1), recent.slice(-4).concat({ role: 'user', content: task }))
      } else {
        assert.deepEqual(member.history.view().slice(0, original.length), original)
      }
      const saved = readFileSync(historyFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(saved, member.history.view())
    } finally {
      await member.close()
      assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
      assert(basename(root).startsWith('meicode-tool-budget-'))
      rmSync(root, { recursive: true, force: true })
    }
  })
}

console.log(`\ncontext_tool_budget_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
