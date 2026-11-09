import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ContextManager } from '../src/context/index.ts'
import { SUMMARY_SYSTEM } from '../src/context/summary.ts'
import type { Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { runIsolated } from '../src/skill/index.ts'
import type { SkillDef } from '../src/skill/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'

let passed = 0
let failed = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_skill_context_'))
const skill: SkillDef = { name: 'context', description: '独立上下文', mode: 'isolated', content: '执行独立任务', source: 'project' }

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function parentContext(history: History, provider: Provider, window = 131072) {
  const manager = new ContextManager({ history, provider, cwd: root, window, autoMargin: 400, manualMargin: 200 })
  manager.afterRequest(26000, history.length)
  const unexpected = () => { throw new Error('误调用主会话回调') }
  const ctx: ToolContext = {
    cwd: root, rootLock: root, sessionId: 'parent-session', agentId: 'parent-agent',
    contextBudget: () => manager.snapshot(),
    beforeRequest: async () => unexpected(), afterRequest: unexpected,
    setRequestOverhead: unexpected, spill: async () => unexpected(),
    permission: {
      mode: 'permissive',
      engine: { match: () => null, addSessionRule: () => {}, appendProjectRule: () => {} },
    },
  }
  return { manager, ctx }
}

try {
  const agentIds = new Set<string>()
  for (const historyCount of [0, 2]) {
    await check(`子会话只计入 ${historyCount} 条继承历史，独立 usage、运行标识及回调保持主会话不变`, async () => {
      const history = new History()
      for (let i = 0; i < 30; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `MAIN-${i}-${'中'.repeat(1000)}` })
      const original = JSON.stringify(history.view())
      const version = history.version
      const registry = new ToolRegistry()
      let captured: ToolContext | undefined
      let requests = 0
      const provider: Provider = {
        protocol: 'openai',
        async *streamChat(messages) {
          if (messages[0].content.startsWith('把下面的执行输出')) {
            assert(messages[1].content.includes('独立工具输出'))
            yield { type: 'text', text: '独立任务摘要' }
          } else {
            requests++
            if (requests === 1) {
              assert.equal(messages.filter((message) => message.content.startsWith('MAIN-')).length, historyCount)
              yield { type: 'usage', inputTokens: 8000, outputTokens: 10 }
              yield { type: 'tool_call', id: 'child-read', name: 'read_file', arguments: {} }
            } else yield { type: 'text', text: '完成' }
          }
          yield { type: 'done' }
        },
      }
      const parent = parentContext(history, provider)
      const before = parent.manager.snapshot()
      registry.register({
        name: 'read_file', description: '检查子会话', parameters: { type: 'object' },
        async execute(_args, ctx) {
          captured = ctx
          const budget = ctx.contextBudget!()
          assert.equal(budget.historyMessages, historyCount + 1)
          assert.equal(budget.lastInputTokens, 8000)
          assert.equal(budget.window, before.window)
          assert.equal(budget.autoMargin, 400)
          assert.equal(budget.manualMargin, 200)
          assert.equal(ctx.rootLock, root)
          assert.equal(ctx.sessionId, 'parent-session')
          assert.notEqual(ctx.agentId, parent.ctx.agentId)
          assert.notEqual(ctx.permission, parent.ctx.permission)
          assert.equal(ctx.permission?.engine, parent.ctx.permission?.engine)
          ctx.permission!.mode = 'strict'
          return { success: true, output: '独立工具输出' }
        },
      })
      assert.equal(await runIsolated({ ...skill, history: historyCount }, history, { provider, registry, ctx: parent.ctx, systemPrompt: 'test' }), '独立任务摘要')
      assert(captured?.agentId)
      assert(!agentIds.has(captured.agentId))
      agentIds.add(captured.agentId)
      assert.equal(parent.ctx.permission?.mode, 'permissive')
      assert.equal(history.version, version)
      assert.equal(JSON.stringify(history.view()), original)
      assert.deepEqual(parent.manager.snapshot(), before)
      assert.equal(requests, 2)
    })
  }

  await check('子会话自动压缩只修改自身历史，最终摘要仍包含已被压缩掉的工具输出', async () => {
    const history = new History()
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'old-read', name: 'read_file', arguments: '{}' }] })
    history.push({ role: 'tool', tool_call_id: 'old-read', content: 'OLD-PARENT-OUTPUT' })
    for (let i = 0; i < 18; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `继承消息${i}-${'旧'.repeat(1000)}` })
    const original = JSON.stringify(history.view())
    const version = history.version
    const registry = new ToolRegistry()
    const firstOutput = `CHILD-FIRST-OUTPUT-${'x'.repeat(4000)}`
    let rounds = 0
    let compactions = 0
    let droppedFirst = false
    let summaryInput = ''
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages) {
        if (messages[0].content === SUMMARY_SYSTEM) {
          compactions++
          if (messages.slice(1).some((message) => message.content === firstOutput)) droppedFirst = true
          yield { type: 'text', text: '压缩后的任务状态' }
        } else if (messages[0].content.startsWith('把下面的执行输出')) {
          summaryInput = messages[1].content
          yield { type: 'text', text: '保留全部执行结果的摘要' }
        } else {
          rounds++
          yield { type: 'usage', inputTokens: 3600, outputTokens: 10 }
          if (rounds < 5) yield { type: 'tool_call', id: `child-read-${rounds}`, name: 'read_file', arguments: { round: rounds } }
          else {
            assert(!messages.some((message) => message.content === firstOutput))
            yield { type: 'text', text: '独立任务结束' }
          }
        }
        yield { type: 'done' }
      },
    }
    registry.register({ name: 'read_file', description: '读取输出', parameters: { type: 'object' }, async execute(args) { return { success: true, output: args.round === 1 ? firstOutput : `CHILD-OUTPUT-${args.round}-${'y'.repeat(900)}` } } })
    const parent = parentContext(history, provider, 4000)
    const before = parent.manager.snapshot()
    const result = await runIsolated({ ...skill, history: 20 }, history, { provider, registry, ctx: parent.ctx, systemPrompt: 'test' })
    assert.equal(result, '保留全部执行结果的摘要')
    assert.equal(rounds, 5)
    assert(compactions > 1)
    assert(droppedFirst)
    assert(summaryInput.includes(firstOutput))
    assert(summaryInput.includes('CHILD-OUTPUT-4'))
    assert(!summaryInput.includes('OLD-PARENT-OUTPUT'))
    assert.equal(history.version, version)
    assert.equal(JSON.stringify(history.view()), original)
    assert.deepEqual(parent.manager.snapshot(), before)
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_skill_context_'))
  const verify = (directory: string) => {
    assert(!lstatSync(directory).isSymbolicLink())
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) verify(join(directory, entry.name))
    }
  }
  verify(target)
  rmSync(target, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
