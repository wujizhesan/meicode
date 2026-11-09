import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ContextManager, SUMMARY_SYSTEM } from '../src/context/index.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { projectStatePath } from '../src/state-paths.ts'
import { SubAgentManager } from '../src/subagent/index.ts'
import type { SpawnRequest } from '../src/subagent/types.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolContext } from '../src/tools/types.ts'
import type { WorktreeManager } from '../src/worktree/index.ts'

let passed = 0
let failed = 0
let fixtureId = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_subagent_context_'))

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
      timer = setTimeout(() => reject(new Error('子 Agent 上下文测试超时')), 4000)
    })])
  } finally { clearTimeout(timer) }
}

function fixture(provider: Provider, window = 131072, worktree = false) {
  const directory = join(root, String(++fixtureId))
  const roles = join(directory, 'roles')
  mkdirSync(roles, { recursive: true })
  writeFileSync(join(roles, 'probe.md'), `---\nname: probe\ndescription: 上下文检查\npermission: permissive\nmax_rounds: 8\n${worktree ? 'isolation: worktree\n' : ''}---\nCHILD-CONTEXT-PROBE\n`)
  const worktreePath = join(directory, 'worktree')
  const worktrees = worktree ? {
    async create() { mkdirSync(worktreePath); return { path: worktreePath, branch: 'test-child' } },
    async exit() { return { dirty: true, path: worktreePath, branch: 'test-child' } },
    release() {},
  } as unknown as WorktreeManager : undefined
  const manager = new SubAgentManager({ builtin: join(directory, 'builtin'), user: join(directory, 'user'), project: roles }, worktrees)
  manager.loadRoles()
  const history = new History()
  for (let i = 0; i < 40; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `MAIN-${i}-${'x'.repeat(1000)}` })
  const contextManager = new ContextManager({ provider, history, cwd: directory, window, autoMargin: 400, manualMargin: 200 })
  contextManager.afterRequest(30000, history.length)
  const original = JSON.stringify(history.view())
  const version = history.version
  const snapshot = contextManager.snapshot()
  const unexpected = () => { throw new Error('误调用父会话上下文回调') }
  const ctx: ToolContext = {
    cwd: directory, rootLock: directory, sessionId: 'parent-session', agentId: 'parent-agent', taskId: 'parent-task',
    permission: { mode: 'permissive', engine: { match: () => null, addSessionRule() {}, appendProjectRule() {} } },
    contextBudget: () => contextManager.snapshot(),
    setRequestOverhead: unexpected, beforeRequest: async () => unexpected(), afterRequest: unexpected,
    spill: async () => unexpected(),
  }
  const assertParentUnchanged = () => {
    assert.equal(history.version, version)
    assert.equal(JSON.stringify(history.view()), original)
    assert.deepEqual(contextManager.snapshot(), snapshot)
    assert.equal(ctx.permission?.mode, 'permissive')
  }
  return { directory, worktreePath, manager, history, contextManager, ctx, assertParentUnchanged }
}

try {
  for (const scenario of [
    { type: 'defined', background: false, inherited: 0 },
    { type: 'defined', background: true, inherited: 0 },
    { type: 'fork', background: true, inherited: 0 },
    { type: 'fork', background: true, inherited: 10 },
  ] as const) {
    await check(`${scenario.type}/${scenario.background ? '后台' : '同步'}/${scenario.inherited} 条历史：预算、回调、权限对象独立`, async () => {
      let rounds = 0
      let captured: ToolContext | undefined
      const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
        assert.notEqual(messages[0].content, SUMMARY_SYSTEM)
        rounds++
        if (rounds === 1) {
          assert.equal(messages.filter((message) => message.content.startsWith('MAIN-')).length, scenario.inherited)
          yield { type: 'usage', inputTokens: 8000, outputTokens: 10 }
          yield { type: 'tool_call', id: 'child-read', name: 'read_file', arguments: {} }
        } else {
          yield { type: 'usage', inputTokens: 9000, outputTokens: 10 }
          yield { type: 'text', text: '独立子任务完成' }
        }
        yield { type: 'done' }
      } }
      const f = fixture(provider)
      const registry = new ToolRegistry()
      registry.register({ name: 'read_file', description: '检查预算', parameters: { type: 'object' }, async execute(_args, ctx) {
        captured = ctx
        const budget = ctx.contextBudget!()
        assert.equal(budget.historyMessages, scenario.inherited + 2)
        assert.equal(budget.lastInputTokens, 8000)
        assert.equal(budget.window, 131072)
        assert.equal(budget.autoMargin, 400)
        assert.equal(budget.manualMargin, 200)
        assert.notEqual(ctx.agentId, f.ctx.agentId)
        assert.equal(ctx.sessionId, f.ctx.sessionId)
        assert.equal(ctx.taskId, 'child-task')
        assert.equal(ctx.rootLock, f.ctx.rootLock)
        assert.notEqual(ctx.permission, f.ctx.permission)
        assert.equal(ctx.permission?.engine, f.ctx.permission?.engine)
        ctx.permission!.mode = 'strict'
        return { success: true, output: 'CURRENT-CHILD-TOOL-OUTPUT' }
      } })
      const request: SpawnRequest = {
        type: scenario.type, role: scenario.type === 'defined' ? 'probe' : undefined,
        prompt: '独立执行', async: scenario.background, taskId: 'child-task',
        parentHistory: scenario.inherited ? f.history.all().slice(-scenario.inherited) : [], parentTools: registry.list(),
      }
      try {
        const submitted = await bounded(f.manager.spawn(request, { provider, registry, ctx: f.ctx }))
        const finished = await bounded(f.manager.waitFor(submitted.id, 3000))
        assert.equal(finished.record?.status, 'done')
        assert(finished.record?.result?.includes('CURRENT-CHILD-TOOL-OUTPUT'))
        assert(captured)
        assert.equal(captured.contextBudget!().lastInputTokens, 9000)
        assert.equal(rounds, 2)
        f.assertParentUnchanged()
      } finally { await bounded(f.manager.close(0)) }
    })
  }

  await check('主预算已超限时，运行短子任务不会压缩主历史或覆盖主 usage', async () => {
    let compactions = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content === SUMMARY_SYSTEM) { compactions++; yield { type: 'text', text: '不应压缩主历史' } }
      else { yield { type: 'usage', inputTokens: 321, outputTokens: 5 }; yield { type: 'text', text: '短任务完成' } }
      yield { type: 'done' }
    } }
    const f = fixture(provider, 6000)
    f.ctx.setRequestOverhead = (tokens) => f.contextManager.setRequestOverhead(tokens)
    f.ctx.beforeRequest = (mode, signal, options) => f.contextManager.beforeRequest(mode, signal, options)
    f.ctx.afterRequest = (usage, count, overhead) => f.contextManager.afterRequest(usage, count, overhead)
    try {
      const result = await bounded(f.manager.spawn({ type: 'defined', role: 'probe', prompt: '短任务' }, { provider, registry: new ToolRegistry(), ctx: f.ctx }))
      assert.equal(f.manager.getRecord(result.id)?.status, 'done')
      assert.equal(compactions, 0)
      f.assertParentUnchanged()
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('两个并发子任务各自保持 usage、历史和运行标识，不互相覆盖', async () => {
    const gate = deferred()
    let started = 0
    const rounds = new Map<string, number>()
    const contexts = new Map<string, ToolContext>()
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      const name = messages.find((message) => message.role === 'user' && message.content.startsWith('TASK-'))!.content
      const round = (rounds.get(name) ?? 0) + 1
      rounds.set(name, round)
      if (round === 1) {
        yield { type: 'usage', inputTokens: name === 'TASK-A' ? 321 : 678, outputTokens: 5 }
        yield { type: 'tool_call', id: `read-${name}`, name: 'read_file', arguments: { name } }
        if (++started === 2) gate.resolve()
        await gate.promise
      } else yield { type: 'text', text: `${name} 完成` }
      yield { type: 'done' }
    } }
    const f = fixture(provider)
    const registry = new ToolRegistry()
    registry.register({ name: 'read_file', description: '并发检查', parameters: { type: 'object' }, async execute(args, ctx) {
      contexts.set(String(args.name), ctx)
      return { success: true, output: `${args.name} 输出` }
    } })
    try {
      const submitted = await Promise.all(['TASK-A', 'TASK-B'].map((prompt) => f.manager.spawn({ type: 'defined', role: 'probe', prompt, async: true }, { provider, registry, ctx: f.ctx })))
      const finished = await bounded(Promise.all(submitted.map((result) => f.manager.waitFor(result.id, 3000))))
      assert(finished.every((result) => result.record?.status === 'done'))
      const a = contexts.get('TASK-A')!
      const b = contexts.get('TASK-B')!
      assert.equal(a.contextBudget!().lastInputTokens, 321)
      assert.equal(b.contextBudget!().lastInputTokens, 678)
      assert.equal(a.contextBudget!().historyMessages, 4)
      assert.equal(b.contextBudget!().historyMessages, 4)
      assert.notEqual(a.agentId, b.agentId)
      f.assertParentUnchanged()
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('子会话自动压缩后，报告保留本次早期工具输出且不改写主历史', async () => {
    const firstOutput = `FIRST-CHILD-OUTPUT-${'x'.repeat(3000)}`
    let rounds = 0
    let compactions = 0
    let firstDropped = false
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content === SUMMARY_SYSTEM) { compactions++; yield { type: 'text', text: '子会话摘要' } }
      else {
        rounds++
        yield { type: 'usage', inputTokens: 3600, outputTokens: 10 }
        if (rounds < 5) yield { type: 'tool_call', id: `read-${rounds}`, name: 'read_file', arguments: { round: rounds } }
        else { firstDropped = !messages.some((message) => message.content === firstOutput); yield { type: 'text', text: '子会话完成' } }
      }
      yield { type: 'done' }
    } }
    const f = fixture(provider, 4000)
    const registry = new ToolRegistry()
    registry.register({ name: 'read_file', description: '工具输出', parameters: { type: 'object' }, async execute(args) {
      return { success: true, output: args.round === 1 ? firstOutput : `${'y'.repeat(900)}-LAST-CHILD-${args.round}` }
    } })
    try {
      const result = await bounded(f.manager.spawn({ type: 'defined', role: 'probe', prompt: '子会话压缩测试' }, { provider, registry, ctx: f.ctx }))
      const record = f.manager.getRecord(result.id)!
      assert.equal(record.status, 'done')
      assert(compactions > 0)
      assert(firstDropped)
      assert(record.result!.includes('FIRST-CHILD-OUTPUT'))
      assert(record.result!.includes('LAST-CHILD-4'))
      f.assertParentUnchanged()
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('取消正在压缩的 fork 只停止子会话，晚到摘要不改写主历史或启动模型', async () => {
    const started = deferred()
    const gate = deferred()
    let models = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      if (messages[0].content === SUMMARY_SYSTEM) {
        started.resolve()
        await resolveOnAbort(gate.promise, options.signal, undefined)
        yield { type: 'text', text: '迟到子会话摘要' }
      } else { models++; yield { type: 'text', text: '不应启动' } }
      yield { type: 'done' }
    } }
    const f = fixture(provider, 4000)
    try {
      const parentHistory = f.history.all().slice(-10).map((message) => ({ ...message, content: `${message.content}${'y'.repeat(5000)}` }))
      const result = await f.manager.spawn({ type: 'fork', prompt: '取消子会话压缩', parentHistory }, { provider, registry: new ToolRegistry(), ctx: f.ctx })
      await bounded(started.promise)
      assert(f.manager.cancel(result.id))
      const finished = await bounded(f.manager.waitFor(result.id, 3000))
      assert.equal(finished.record?.status, 'cancelled')
      assert.equal(models, 0)
      gate.resolve()
      await new Promise<void>((done) => setImmediate(done))
      f.assertParentUnchanged()
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('worktree 子任务的大输出落盘使用自身目录，父 spill 回调不执行', async () => {
    let rounds = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++rounds === 1) yield { type: 'tool_call', id: 'large-child-output', name: 'read_file', arguments: {} }
      else yield { type: 'text', text: '大输出完成' }
      yield { type: 'done' }
    } }
    const f = fixture(provider, 131072, true)
    const registry = new ToolRegistry()
    registry.register({ name: 'read_file', description: '大输出', parameters: { type: 'object' }, async execute(_args, ctx) {
      assert.equal(ctx.cwd, f.worktreePath)
      return { success: true, output: `WORKTREE-OUTPUT-${'x'.repeat(60000)}` }
    } })
    try {
      const result = await bounded(f.manager.spawn({ type: 'defined', role: 'probe', prompt: '隔离大输出' }, { provider, registry, ctx: f.ctx }))
      assert.equal(f.manager.getRecord(result.id)?.status, 'done')
      assert(existsSync(projectStatePath(f.worktreePath, 'artifacts')))
      assert.equal(readdirSync(projectStatePath(f.worktreePath, 'artifacts')).length, 1)
      assert(!existsSync(projectStatePath(f.directory, 'artifacts')))
      assert(result.syncResult?.includes('WORKTREE-OUTPUT'))
      f.assertParentUnchanged()
    } finally { await bounded(f.manager.close(0)) }
  })

  for (const output of ['text', 'tool', 'empty'] as const) {
    await check(`fork 本轮 ${output} 结果不混入继承工具输出`, async () => {
      let rounds = 0
      const inherited: ChatMessage[] = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'parent-read', name: 'read_file', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'parent-read', content: 'OLD-PARENT-TOOL-OUTPUT' },
      ]
      const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
        rounds++
        assert(messages.some((message) => message.content === 'OLD-PARENT-TOOL-OUTPUT'))
        if (output === 'tool' && rounds === 1) yield { type: 'tool_call', id: 'current-child-read', name: 'read_file', arguments: {} }
        else if (output !== 'empty') yield { type: 'text', text: 'CURRENT-CHILD-RESULT' }
        yield { type: 'done' }
      } }
      const f = fixture(provider)
      const registry = new ToolRegistry()
      registry.register({ name: 'read_file', description: '本次读取', parameters: { type: 'object' }, async execute() { return { success: true, output: 'CURRENT-CHILD-TOOL-OUTPUT' } } })
      try {
        const submitted = await f.manager.spawn({ type: 'fork', prompt: '新任务', parentHistory: inherited, parentTools: registry.list() }, { provider, registry, ctx: f.ctx })
        const finished = await bounded(f.manager.waitFor(submitted.id, 3000))
        assert.equal(finished.record?.status, 'done')
        const summary = finished.record!.result!
        assert(!summary.includes('OLD-PARENT-TOOL-OUTPUT'))
        if (output === 'empty') assert.equal(summary, '子任务已完成')
        else assert(summary.includes('CURRENT-CHILD-RESULT'))
        assert.equal(summary.includes('CURRENT-CHILD-TOOL-OUTPUT'), output === 'tool')
        assert.deepEqual(inherited[1], { role: 'tool', tool_call_id: 'parent-read', content: 'OLD-PARENT-TOOL-OUTPUT' })
        f.assertParentUnchanged()
      } finally { await bounded(f.manager.close(0)) }
    })
  }
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_subagent_context_'))
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
