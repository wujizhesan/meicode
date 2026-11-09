import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { createLoadSkillTool, runIsolated, SkillManager } from '../src/skill/index.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'

let passed = 0
let failed = 0
let fixtureId = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_skill_scope_'))

async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${String(error)}`) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Skill 作用域测试超时')), 3000)
    })])
  } finally { clearTimeout(timer) }
}

function fixture(rootTools?: string[]) {
  const directory = join(root, String(++fixtureId))
  const project = join(directory, 'skills')
  mkdirSync(project, { recursive: true })
  const writeSkill = (name: string, mode: 'shared' | 'isolated', tools?: string[]) => {
    writeFileSync(join(project, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\nmode: ${mode}\nhistory: 0\n${tools === undefined ? '' : `tools: ${JSON.stringify(tools)}\n`}---\nSCOPE-INSTRUCTIONS-${name}\n`)
  }
  writeSkill('root', 'isolated', rootTools)
  const manager = new SkillManager({ builtin: join(directory, 'builtin'), user: join(directory, 'user'), project })
  manager.loadAll()
  manager.activate('root')
  const registry = new ToolRegistry()
  registry.register(createLoadSkillTool(manager))
  const calls = { read: 0, write: 0, activations: 0 }
  manager.setOnActivate(() => { calls.activations++ })
  for (const name of ['read_file', 'write_file']) registry.register({
    name, description: name, parameters: { type: 'object' },
    async execute() { if (name === 'read_file') calls.read++; else calls.write++; return { success: true, output: `${name} 已执行` } },
  })
  const history = new History()
  history.push({ role: 'user', content: 'MAIN-SESSION-CONTENT' })
  const ctx: ToolContext = {
    cwd: directory, sessionId: 'main-session', agentId: 'main-agent',
    permission: { mode: 'permissive', engine: { match: () => null, addSessionRule() {}, appendProjectRule() {} } },
  }
  const assertParentUnchanged = () => {
    assert.equal(manager.activePrompt(), '')
    assert.equal(manager.activeToolNames(), null)
    assert.deepEqual(manager.lastActivated, { name: 'root', mode: 'isolated' })
    assert.equal(calls.activations, 0)
    assert.deepEqual(history.view(), [{ role: 'user', content: 'MAIN-SESSION-CONTENT' }])
    assert.equal(manager.takeNextIsolated()?.name, 'root')
    assert.equal(manager.takeNextIsolated(), undefined)
  }
  return { manager, registry, history, ctx, calls, writeSkill, assertParentUnchanged }
}

try {
  for (const scenario of [
    { name: '共享 Skill 空工具范围', nestedTools: [], expected: ['load_skill'] },
    { name: '共享 Skill 读工具范围', nestedTools: ['read_file'], expected: ['load_skill', 'read_file'] },
    { name: '共享 Skill 无工具限制', nestedTools: undefined, expected: ['load_skill', 'read_file', 'write_file'] },
    { name: '共享 Skill 不能扩大独立任务范围', rootTools: ['read_file'], nestedTools: ['write_file'], expected: ['load_skill'] },
    { name: '共享 Skill 不能扩大调用方范围', override: true, nestedTools: ['write_file'], expected: ['load_skill'] },
  ]) {
    await check(`${scenario.name}在子会话下一轮生效，主会话保持不变`, async () => {
      const f = fixture(scenario.rootTools)
      f.writeSkill('nested', 'shared', scenario.nestedTools)
      f.manager.loadAll()
      let rounds = 0
      const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
        if (messages[0].content.startsWith('把下面的执行输出')) yield { type: 'text', text: '局部 Skill 摘要' }
        else if (++rounds === 1) {
          assert(!messages.some((message) => message.content.includes('SCOPE-INSTRUCTIONS-nested')))
          yield { type: 'tool_call', id: 'load-nested', name: 'load_skill', arguments: { name: 'nested' } }
        } else {
          assert(messages.some((message) => message.role === 'system' && message.content.includes('SCOPE-INSTRUCTIONS-nested')))
          assert.deepEqual(options.tools!.map((tool) => tool.function.name).sort(), scenario.expected)
          if (rounds === 2) {
            yield { type: 'tool_call', id: 'read-local', name: 'read_file', arguments: {} }
            yield { type: 'tool_call', id: 'write-local', name: 'write_file', arguments: {} }
          } else yield { type: 'text', text: '子会话完成' }
        }
        yield { type: 'done' }
      } }
      const parentTool = f.registry.get('load_skill')
      assert.equal(await bounded(runIsolated(f.manager.get('root')!, f.history, {
        provider, registry: f.registry, ctx: f.ctx, systemPrompt: 'ISOLATED-BASE',
        toolsOverride: scenario.override ? f.registry.toOpenAITools().filter((tool) => tool.function.name !== 'write_file') : undefined,
      })), '局部 Skill 摘要')
      assert.equal(f.calls.read, scenario.expected.includes('read_file') ? 1 : 0)
      assert.equal(f.calls.write, scenario.expected.includes('write_file') ? 1 : 0)
      assert.equal(f.registry.get('load_skill'), parentTool)
      f.assertParentUnchanged()
    })
  }

  await check('并发独立任务的嵌套共享 Skill 不互相污染', async () => {
    const f = fixture()
    f.writeSkill('local-a', 'shared', ['read_file'])
    f.writeSkill('local-b', 'shared', ['write_file'])
    f.manager.loadAll()
    const gate = deferred()
    let loads = 0
    const rounds = { a: 0, b: 0 }
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      if (messages[0].content.startsWith('把下面的执行输出')) yield { type: 'text', text: '并发任务摘要' }
      else {
        const key = messages[0].content.includes('ROOT-A') ? 'a' : 'b'
        if (++rounds[key] === 1) {
          yield { type: 'tool_call', id: `load-${key}`, name: 'load_skill', arguments: { name: `local-${key}` } }
          if (++loads === 2) gate.resolve()
          await gate.promise
        } else {
          assert(messages.some((message) => message.content.includes(`SCOPE-INSTRUCTIONS-local-${key}`)))
          assert(!messages.some((message) => message.content.includes(`SCOPE-INSTRUCTIONS-local-${key === 'a' ? 'b' : 'a'}`)))
          assert.deepEqual(options.tools!.map((tool) => tool.function.name).sort(), ['load_skill', key === 'a' ? 'read_file' : 'write_file'])
          yield { type: 'text', text: `任务 ${key} 完成` }
        }
      }
      yield { type: 'done' }
    } }
    const runs = ['A', 'B'].map((key) => runIsolated({ ...f.manager.get('root')!, name: `root-${key}`, content: `ROOT-${key}` }, f.history, {
      provider, registry: f.registry, ctx: f.ctx, systemPrompt: 'ISOLATED-BASE',
    }))
    try { assert.deepEqual(await bounded(Promise.all(runs)), ['并发任务摘要', '并发任务摘要']) }
    finally { gate.resolve(); await Promise.allSettled(runs) }
    f.assertParentUnchanged()
  })

  for (const failFirst of [false, true]) {
    await check(`嵌套独立任务按本地队列执行，首项${failFirst ? '失败' : '成功'}后继续并汇总到当前子会话`, async () => {
      const f = fixture(['read_file'])
      f.writeSkill('nested-a', 'isolated', ['write_file'])
      f.writeSkill('nested-b', 'isolated', ['read_file'])
      f.manager.loadAll()
      const rounds = new Map<string, number>()
      const started: string[] = []
      let rootSummary = ''
      const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
        if (messages[0].content.startsWith('把下面的执行输出')) {
          if (messages[1].content.includes('ROOT-OUTPUT')) rootSummary = messages[1].content
          yield { type: 'text', text: messages[1].content.includes('NESTED-B-OUTPUT') ? 'NESTED-B-SUMMARY' : 'NESTED-A-SUMMARY' }
        } else {
          const name = ['nested-a', 'nested-b'].find((name) => messages[0].content.includes(`SCOPE-INSTRUCTIONS-${name}`)) ?? 'root'
          const round = (rounds.get(name) ?? 0) + 1
          rounds.set(name, round)
          if (name === 'root') {
            if (round === 1) for (const name of ['nested-a', 'nested-b']) yield { type: 'tool_call', id: `load-${name}`, name: 'load_skill', arguments: { name } }
            else yield { type: 'text', text: 'ROOT-OUTPUT' }
          } else {
            if (round === 1) started.push(name)
            assert.deepEqual(options.tools!.map((tool) => tool.function.name).sort(), name === 'nested-a' ? ['load_skill'] : ['load_skill', 'read_file'])
            if (name === 'nested-a' && failFirst) yield { type: 'error', message: 'LOCAL-NESTED-ERROR' }
            else if (round === 1) yield { type: 'tool_call', id: `local-${name}`, name: name === 'nested-a' ? 'write_file' : 'read_file', arguments: {} }
            else yield { type: 'text', text: name === 'nested-a' ? 'NESTED-A-OUTPUT' : 'NESTED-B-OUTPUT' }
          }
        }
        yield { type: 'done' }
      } }
      await bounded(runIsolated(f.manager.get('root')!, f.history, { provider, registry: f.registry, ctx: f.ctx, systemPrompt: 'ISOLATED-BASE' }))
      assert.deepEqual(started, ['nested-a', 'nested-b'])
      assert(rootSummary.includes(failFirst ? 'LOCAL-NESTED-ERROR' : 'NESTED-A-SUMMARY'))
      assert(rootSummary.includes('NESTED-B-SUMMARY'))
      assert.equal(f.calls.write, 0)
      assert.equal(f.calls.read, 1)
      f.assertParentUnchanged()
    })
  }

  await check('嵌套独立任务取消后停止剩余队列，不摘要、不激活主会话 Skill', async () => {
    const f = fixture()
    for (const name of ['nested-a', 'nested-b']) f.writeSkill(name, 'isolated')
    f.manager.loadAll()
    const started = deferred()
    const gate = deferred()
    const controller = new AbortController()
    let rootRounds = 0
    let summaries = 0
    let secondStarted = false
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      if (messages[0].content.startsWith('把下面的执行输出')) { summaries++; yield { type: 'text', text: '不应摘要' } }
      else if (messages[0].content.includes('SCOPE-INSTRUCTIONS-nested-a')) {
        started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined)
        yield { type: 'text', text: '迟到结果' }
      } else if (messages[0].content.includes('SCOPE-INSTRUCTIONS-nested-b')) { secondStarted = true; yield { type: 'text', text: '不应运行' } }
      else if (++rootRounds === 1) for (const name of ['nested-a', 'nested-b']) yield { type: 'tool_call', id: `load-${name}`, name: 'load_skill', arguments: { name } }
      else yield { type: 'text', text: '父独立任务完成' }
      yield { type: 'done' }
    } }
    const running = runIsolated(f.manager.get('root')!, f.history, { provider, registry: f.registry, ctx: f.ctx, signal: controller.signal, systemPrompt: 'ISOLATED-BASE' })
    try {
      await bounded(started.promise)
      controller.abort()
      await assert.rejects(bounded(running), (error: Error) => error.name === 'AbortError')
      assert.equal(summaries, 0)
      assert.equal(secondStarted, false)
      f.assertParentUnchanged()
    } finally { gate.resolve(); await running.catch(() => {}) }
  })

  await check('嵌套 Skill 循环被限制并留在局部摘要，不反复启动或污染主队列', async () => {
    const f = fixture()
    let executions = 0
    let summaryInput = ''
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) { summaryInput = messages[1].content; yield { type: 'text', text: '检测到嵌套循环' } }
      else if (++executions === 1) yield { type: 'tool_call', id: 'load-self', name: 'load_skill', arguments: { name: 'root' } }
      else yield { type: 'text', text: '局部任务完成' }
      yield { type: 'done' }
    } }
    assert.equal(await bounded(runIsolated(f.manager.get('root')!, f.history, { provider, registry: f.registry, ctx: f.ctx, systemPrompt: 'ISOLATED-BASE' })), '检测到嵌套循环')
    assert.equal(executions, 2)
    assert(summaryInput.includes('嵌套循环或层数过多'))
    f.assertParentUnchanged()
  })

  await check('独立 Skill 嵌套达到八层后停止继续派发，错误向当前摘要回流', async () => {
    const f = fixture()
    for (let i = 1; i <= 8; i++) f.writeSkill(`depth-${i}`, 'isolated')
    f.manager.loadAll()
    const rounds = new Map<string, number>()
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) {
        yield { type: 'text', text: messages[1].content.includes('层数过多') ? '嵌套层数过多' : '任务摘要' }
      } else {
        const depth = Number(/SCOPE-INSTRUCTIONS-depth-(\d+)/.exec(messages[0].content)?.[1] ?? 0)
        const name = depth === 0 ? 'root' : `depth-${depth}`
        const round = (rounds.get(name) ?? 0) + 1
        rounds.set(name, round)
        if (round === 1) yield { type: 'tool_call', id: `load-depth-${depth}`, name: 'load_skill', arguments: { name: `depth-${depth + 1}` } }
        else yield { type: 'text', text: `任务 ${depth} 完成` }
      }
      yield { type: 'done' }
    } }
    assert.equal(await bounded(runIsolated(f.manager.get('root')!, f.history, { provider, registry: f.registry, ctx: f.ctx, systemPrompt: 'ISOLATED-BASE' })), '嵌套层数过多')
    assert.equal(rounds.size, 8)
    assert.equal(rounds.has('depth-8'), false)
    assert([...rounds.values()].every((count) => count === 2))
    f.assertParentUnchanged()
  })

  await check('子会话结束清理自身遗留 Hook，主会话待注入提示保持完整', async () => {
    const f = fixture()
    const hooks = new HookEngine([
      { event: 'round_end', action: { type: 'inject_prompt', content: 'CHILD-HOOK' } },
      { event: 'message', action: { type: 'inject_prompt', content: 'PARENT-HOOK' } },
    ])
    await hooks.fire('message', { cwd: f.ctx.cwd, sessionId: f.ctx.sessionId, agentId: f.ctx.agentId })
    let childId = ''
    f.registry.register({ name: 'capture', description: '读取运行标识', parameters: { type: 'object' }, async execute(_args, ctx) { childId = ctx.agentId!; return { success: true, output: '标识已读取' } } })
    let rounds = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      assert(!messages.some((message) => message.content === 'PARENT-HOOK'))
      if (messages[0].content.startsWith('把下面的执行输出')) yield { type: 'text', text: '子会话摘要' }
      else if (++rounds === 1) yield { type: 'tool_call', id: 'capture-child', name: 'capture', arguments: {} }
      else yield { type: 'text', text: '子会话完成' }
      yield { type: 'done' }
    } }
    await bounded(runIsolated(f.manager.get('root')!, f.history, { provider, registry: f.registry, ctx: { ...f.ctx, hooks }, systemPrompt: 'ISOLATED-BASE' }))
    assert(childId && childId !== f.ctx.agentId)
    assert.deepEqual(hooks.collectInjections({ sessionId: f.ctx.sessionId, agentId: childId }), [])
    assert.deepEqual(hooks.collectInjections(f.ctx), ['PARENT-HOOK'])
  })

  await check('Skill 作用域复制定义，不继承激活队列、参数或主会话回调', async () => {
    const f = fixture()
    f.writeSkill('shared', 'shared', ['read_file'])
    f.manager.loadAll()
    f.manager.get('shared')!.content = '{{value}}'
    f.manager.activate('shared', { value: 'PARENT-PARAMETER' })
    const scope = f.manager.createScope()
    assert.equal(scope.activePrompt(), '')
    assert.equal(scope.takeNextIsolated(), undefined)
    assert.equal(scope.lastActivated, null)
    scope.activate('shared', { value: 'CHILD-PARAMETER' })
    scope.get('shared')!.tools!.push('write_file')
    assert(scope.activePrompt().includes('CHILD-PARAMETER'))
    assert(f.manager.activePrompt().includes('PARENT-PARAMETER'))
    assert.deepEqual(f.manager.activeToolNames(), ['read_file'])
    assert.equal(f.calls.activations, 1)
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_skill_scope_'))
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
