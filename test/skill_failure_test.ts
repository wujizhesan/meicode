import assert from 'node:assert/strict'
import { History } from '../src/session/history.ts'
import { runIsolated, SkillRunError } from '../src/skill/index.ts'
import type { SkillDef } from '../src/skill/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/index.ts'

let passed = 0
let failed = 0

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

const skill: SkillDef = { name: 'review', description: '独立审查', mode: 'isolated', content: '审查任务', source: 'project' }

function fixture(
  execute: (round: number) => AsyncGenerator<StreamEvent>,
  summarize: () => AsyncGenerator<StreamEvent> = async function* () { yield { type: 'text', text: '摘要：已完成' }; yield { type: 'done' } },
) {
  const history = new History()
  history.push({ role: 'user', content: '主任务' })
  history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'parent-read', name: 'read_file', arguments: '{}' }] })
  history.push({ role: 'tool', tool_call_id: 'parent-read', content: 'PARENT-TOOL-OUTPUT' })
  const registry = new ToolRegistry()
  registry.register({ name: 'read_file', description: 'read', parameters: { type: 'object' }, async execute(args) { return { success: true, output: `CURRENT-TOOL-${args.path}` } } })
  registry.register({ name: 'probe', description: 'probe', parameters: { type: 'object' }, async execute() { return { success: true, output: '探测完成' } } })
  let executions = 0
  let summaries = 0
  let summaryInput = ''
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) {
        summaries++
        summaryInput = messages[1].content
        yield* summarize()
      } else {
        executions++
        yield* execute(executions)
      }
    },
  }
  return {
    history, registry,
    get executions() { return executions },
    get summaries() { return summaries },
    get summaryInput() { return summaryInput },
    run: (signal?: AbortSignal) => runIsolated(skill, history, { provider, registry, ctx: { cwd: process.cwd() }, systemPrompt: 'test', signal }),
  }
}

async function failure(f: ReturnType<typeof fixture>, stage: SkillRunError['stage'], pattern: RegExp): Promise<SkillRunError> {
  const snapshot = JSON.stringify(f.history.view())
  let caught: unknown
  try { await f.run() }
  catch (error) { caught = error }
  assert(caught instanceof SkillRunError)
  assert.equal(caught.stage, stage)
  assert.match(caught.message, pattern)
  assert(!caught.output.includes('PARENT-TOOL-OUTPUT'))
  assert.equal(JSON.stringify(f.history.view()), snapshot)
  return caught
}

for (const partial of [false, true]) {
  await check(`执行模型报错${partial ? '且已有文本' : '且无输出'}，保留原因并跳过摘要`, async () => {
    const f = fixture(async function* () {
      if (partial) yield { type: 'text', text: '未完成的审查结论' }
      yield { type: 'error', message: 'CHILD_HTTP_500' }
      yield { type: 'done' }
    })
    const error = await failure(f, 'execution', /CHILD_HTTP_500/)
    assert.equal(error.output, partial ? '未完成的审查结论' : '')
    assert.equal(f.executions, 1)
    assert.equal(f.summaries, 0)
  })
}

await check('执行模型抛出异常时不请求摘要', async () => {
  // biome-ignore lint/correctness/useYield: 执行流桩 provider 直接抛错，不需要 yield
  const f = fixture(async function* () { throw new Error('CHILD_STREAM_BROKE') })
  await failure(f, 'execution', /CHILD_STREAM_BROKE/)
  assert.equal(f.summaries, 0)
})

await check('跑满 8 轮保留实际工具输出并明确未完成', async () => {
  const f = fixture(async function* (round) {
    yield { type: 'tool_call', id: `read-${round}`, name: 'read_file', arguments: { path: round } }
    yield { type: 'done' }
  })
  const error = await failure(f, 'execution', /达到迭代上限（8 轮）/)
  assert.equal(f.executions, 8)
  assert.equal(f.summaries, 0)
  assert(error.output.includes('CURRENT-TOOL-8'))
})

await check('连续工具失败不包装为完成结果', async () => {
  const f = fixture(async function* (round) {
    yield { type: 'tool_call', id: `read-${round}`, name: 'read_file', arguments: { path: round } }
    yield { type: 'done' }
  })
  f.registry.get('read_file')!.execute = async () => ({ success: false, output: '', error: '读取失败' })
  const error = await failure(f, 'execution', /工具连续失败/)
  assert.equal(f.executions, 3)
  assert.equal(f.summaries, 0)
  assert(error.output.includes('读取失败'))
})

await check('连续未知工具不包装为完成结果', async () => {
  const f = fixture(async function* (round) {
    yield { type: 'tool_call', id: `unknown-${round}`, name: 'missing_tool', arguments: {} }
    yield { type: 'done' }
  })
  await failure(f, 'execution', /连续调用未知工具/)
  assert.equal(f.executions, 2)
  assert.equal(f.summaries, 0)
})

await check('重复工具止损不包装为完成结果', async () => {
  const f = fixture(async function* (round) {
    yield { type: 'tool_call', id: `probe-${round}`, name: 'probe', arguments: {} }
    yield { type: 'done' }
  })
  await failure(f, 'execution', /重复调用工具 probe/)
  assert.equal(f.executions, 5)
  assert.equal(f.summaries, 0)
})

for (const partial of [false, true]) {
  await check(`摘要错误事件${partial ? '发生在部分摘要之后' : '且无摘要'}，保留执行输出`, async () => {
    const f = fixture(async function* () { yield { type: 'text', text: '执行已完成的原始输出' }; yield { type: 'done' } }, async function* () {
      if (partial) yield { type: 'text', text: '不能接受的半截摘要' }
      yield { type: 'error', message: 'SUMMARY_HTTP_500' }
      yield { type: 'text', text: '错误后的假成功' }
      yield { type: 'done' }
    })
    const error = await failure(f, 'summary', /SUMMARY_HTTP_500/)
    assert.equal(error.output, '执行已完成的原始输出')
    assert.equal(f.summaries, 1)
  })
}

await check('摘要请求抛出异常保留执行输出与错误', async () => {
  // biome-ignore lint/correctness/useYield: 摘要流桩 provider 直接抛错，不需要 yield
  const f = fixture(async function* () { yield { type: 'text', text: '完成输出' }; yield { type: 'done' } }, async function* () { throw new Error('SUMMARY_STREAM_BROKE') })
  const error = await failure(f, 'summary', /SUMMARY_STREAM_BROKE/)
  assert.equal(error.output, '完成输出')
})

await check('空摘要明确报告失败并保留工具输出', async () => {
  const f = fixture(async function* (round) {
    if (round === 1) yield { type: 'tool_call', id: 'child-read', name: 'read_file', arguments: { path: 'child' } }
    yield { type: 'done' }
  }, async function* () { yield { type: 'text', text: '  ' }; yield { type: 'done' } })
  const error = await failure(f, 'summary', /摘要返回为空/)
  assert.equal(error.output, 'CURRENT-TOOL-child')
})

await check('正常完成只摘要本次 Skill 输出，不混入主任务的旧工具结果', async () => {
  const f = fixture(async function* (round) {
    if (round === 1) yield { type: 'tool_call', id: 'child-read', name: 'read_file', arguments: { path: 'child' } }
    else yield { type: 'text', text: '最终结论' }
    yield { type: 'done' }
  }, async function* () { yield { type: 'text', text: '  正常摘要  ' }; yield { type: 'done' } })
  const snapshot = JSON.stringify(f.history.view())
  assert.equal(await f.run(), '正常摘要')
  assert.equal(f.executions, 2)
  assert.equal(f.summaries, 1)
  assert(f.summaryInput.includes('CURRENT-TOOL-child'))
  assert(f.summaryInput.includes('最终结论'))
  assert(!f.summaryInput.includes('PARENT-TOOL-OUTPUT'))
  assert.equal(JSON.stringify(f.history.view()), snapshot)
})

await check('正常完成但没有新输出时不摘要父任务历史', async () => {
  const f = fixture(async function* () { yield { type: 'done' } })
  assert.equal(await f.run(), '（子会话未产生输出）')
  assert.equal(f.summaries, 0)
})

await check('摘要报错同时取消时优先报告取消', async () => {
  const controller = new AbortController()
  const f = fixture(async function* () { yield { type: 'text', text: '原始输出' }; yield { type: 'done' } }, async function* () {
    controller.abort()
    yield { type: 'error', message: '取消后的错误' }
  })
  await assert.rejects(f.run(controller.signal), { name: 'AbortError' })
})

for (const historyCount of [0, 2, undefined, 99]) {
  await check(`独立 Skill 按 history=${String(historyCount)} 携带历史，主会话保持完整`, async () => {
    const history = new History()
    for (let index = 0; index < 12; index++) {
      history.push({ role: index % 2 ? 'assistant' : 'user', content: `MAIN-HISTORY-${index}` })
    }
    const snapshot = JSON.stringify(history.view())
    const requests: string[][] = []
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages) {
        requests.push(messages.map((message) => message.content))
        yield { type: 'text', text: '独立执行结果' }
        yield { type: 'done' }
      },
    }
    assert.equal(await runIsolated({ ...skill, history: historyCount }, history, {
      provider, registry: new ToolRegistry(), ctx: { cwd: process.cwd() }, systemPrompt: 'test',
    }), '独立执行结果')
    const expected = historyCount === 0 ? [] : history.view().slice(-(historyCount ?? 5)).map((message) => message.content)
    assert.deepEqual(requests[0].filter((content) => content.startsWith('MAIN-HISTORY-')), expected)
    assert.equal(JSON.stringify(history.view()), snapshot)
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
