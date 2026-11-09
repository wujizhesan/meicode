import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { act, createElement } from 'react'
import { render } from 'ink'
import { runAgent } from '../src/agent/loop.ts'
import { HookEngine } from '../src/hook/engine.ts'
import { SessionStore, updateNotes } from '../src/memory/index.ts'
import { McpClientManager } from '../src/mcp/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { createLoadSkillTool, SkillManager } from '../src/skill/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { useStreamingChat } from '../src/tui/useStream.ts'

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

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

// ink 的渲染提交是异步的：发送的同步结束不代表 UI 状态已落盘，
// 实测在高负载下一次 setImmediate 远不够（最长观测到 1.7s 才提交）。
// 所有等待统一走 act()，由其保证返回时 React 已把队列内的更新全部提交。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 后台分支（笔记更新、子结果回流、ink 自身渲染）仍会在 act 之外触发更新，
// React 会给每一条都刷一行警告。这些警告无害，但失败时会淹没真正的断言输出，
// 因此只过滤这一条已知噪音，其余 console 输出原样放行。
const passthroughError = console.error.bind(console)
console.error = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].includes('was not wrapped in act')) return
  passthroughError(...args)
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await act(async () => Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('发送未及时结束')), 3000) }),
    ]))
  } finally {
    clearTimeout(timer)
  }
}

const tick = async (): Promise<void> => {
  await act(async () => { await new Promise<void>((done) => setImmediate(done)) })
}
async function waitForState(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('界面状态未及时更新')
    await tick()
  }
}
const marker = 'ISOLATED-CANCELLATION-TEST'

function isPlanRequest(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'system' && (
    message.content.startsWith('当前处于计划模式：') || message.content === '计划模式：仅读类工具，禁止修改。'
  ))
}

async function mount(source: Provider, options: { mcp?: McpClientManager; skill?: boolean; notes?: boolean; hooks?: HookEngine } = {}) {
  const root = mkdtempSync(join(import.meta.dirname, 'fixtures_send_cancel_'))
  const history = new History()
  const registry = new ToolRegistry()
  const store = new SessionStore(join(root, 'sessions'))
  const memory = {
    sessionStore: store,
    sessionId: 'send-cancel',
    ...(options.notes ? { noteUserDir: join(root, 'notes-user'), noteProjectDir: join(root, 'notes-project') } : {}),
  }
  const skillManager = options.skill ? new SkillManager({ builtin: join(root, 'builtin'), user: join(root, 'user'), project: join(root, 'skills') }) : null
  if (skillManager) {
    mkdirSync(join(root, 'skills'))
    writeFileSync(join(root, 'skills', 'review.md'), `---\nname: review\ndescription: 独立审查\nmode: isolated\n---\n${marker}\n`)
    skillManager.loadAll()
    registry.register(createLoadSkillTool(skillManager))
  }
  const engine = new RuleEngine(join(root, 'rules-user.json'), join(root, 'rules-project.json'), join(root, 'rules-local.json'))
  const mounted = deferred()
  let chat!: ReturnType<typeof useStreamingChat>
  function Harness() {
    chat = useStreamingChat(source, history, registry, engine, async () => 'once', undefined, options.mcp, 131072, memory, skillManager, options.hooks)
    mounted.resolve()
    return null
  }
  const output = new PassThrough()
  output.resume()
  const input = new PassThrough()
  const app = render(createElement(Harness), {
    stdout: output as unknown as typeof process.stdout,
    stderr: output as unknown as typeof process.stderr,
    stdin: input as unknown as typeof process.stdin,
    patchConsole: false, exitOnCtrlC: false, interactive: false,
  })
  await bounded(mounted.promise)
  return {
    get chat() { return chat }, root, history, registry, store, memory, skillManager,
    unmount: () => app.unmount(),
    async close() {
      chat.cancel()
      const exited = app.waitUntilExit()
      app.unmount()
      await bounded(exited)
      input.destroy()
      output.destroy()
      const target = resolve(root)
      assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_send_cancel_'))
      const verify = (directory: string) => {
        assert(!lstatSync(directory).isSymbolicLink())
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          assert(!entry.isSymbolicLink())
          if (entry.isDirectory()) verify(join(directory, entry.name))
        }
      }
      verify(target)
      rmSync(target, { recursive: true, force: true })
    },
  }
}

function assertCancelled(f: Awaited<ReturnType<typeof mount>>) {
  assert.equal(f.chat.mode, 'idle')
  assert.equal(f.chat.lastReason, 'cancelled')
  assert.equal(f.chat.error, '已取消')
  assert.equal(f.chat.roundInfo, null)
  assert.equal(f.skillManager?.lastActivated ?? null, null)
  assert(!f.history.view().some((message) => message.content.includes('[Skill review 结果]')))
  assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
}

function skillProvider(waitAt?: 'main' | 'isolated' | 'summary') {
  const started = deferred()
  const gate = deferred()
  const summaryClosed = deferred()
  const calls = { main: 0, isolated: 0, summary: 0 }
  const signals: AbortSignal[] = []
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      if (opts.signal) signals.push(opts.signal)
      if (messages[0].content.startsWith('把下面的执行输出')) {
        calls.summary++
        try {
          if (waitAt === 'summary') {
            yield { type: 'text', text: '未完成摘要' }
            started.resolve()
            await gate.promise
          }
          yield { type: 'text', text: '独立审查摘要' }
          yield { type: 'done' }
        } finally {
          summaryClosed.resolve()
        }
      } else if (messages[0].content.includes(marker)) {
        calls.isolated++
        if (waitAt === 'isolated') {
          started.resolve()
          await resolveOnAbort(gate.promise, opts.signal, undefined)
        }
        yield { type: 'text', text: '独立执行结果' }
        yield { type: 'done' }
      } else {
        calls.main++
        if (calls.main === 1) {
          yield { type: 'tool_call', id: 'load-review', name: 'load_skill', arguments: { name: 'review' } }
        } else {
          if (waitAt === 'main') {
            started.resolve()
            await resolveOnAbort(gate.promise, opts.signal, undefined)
          }
          yield { type: 'text', text: '主流程完成' }
        }
        yield { type: 'done' }
      }
    },
  }
  return { provider, calls, signals, started, gate, summaryClosed }
}

await check('MCP 发现中取消立即保存问题，迟到发现不请求模型且下次可发送', async () => {
  const started = deferred()
  const gate = deferred()
  const manager = new McpClientManager([])
  let discoveries = 0
  manager.discoverAll = async () => { discoveries++; started.resolve(); await gate.promise; return { ok: [], failed: [] } }
  let requests = 0
  const f = await mount({ protocol: 'openai', async *streamChat() { requests++; yield { type: 'text', text: '后续回答' }; yield { type: 'done' } } }, { mcp: manager })
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('保留取消的问题')
    await bounded(started.promise)
    await f.chat.send('重复发送应忽略')
    f.chat.cancel()
    await bounded(pending)
    await tick()
    assertCancelled(f)
    assert.equal(requests, 0)
    assert.deepEqual(f.history.view(), [{ role: 'user', content: '保留取消的问题' }])
    gate.resolve()
    await tick()
    assert.equal(requests, 0)
    await bounded(f.chat.send('下一次发送'))
    await tick()
    assert.equal(requests, 1)
    assert.equal(discoveries, 1)
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(f.chat.mode, 'idle')
    assert.equal(f.history.view().at(-1)?.content, '后续回答')
  } finally {
    gate.resolve()
    if (pending) await bounded(pending)
    await f.close()
  }
})

await check('取消后的 MCP 发现失败不覆盖 UI 或污染下一次发送', async () => {
  const started = deferred()
  const gate = deferred()
  const manager = new McpClientManager([])
  let discoveries = 0
  manager.discoverAll = async () => {
    discoveries++
    if (discoveries === 1) { started.resolve(); await gate.promise }
    return { ok: [], failed: [] }
  }
  let requests = 0
  const f = await mount({ protocol: 'openai', async *streamChat() { requests++; yield { type: 'done' } } }, { mcp: manager })
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('取消首次连接')
    await bounded(started.promise)
    f.chat.cancel()
    await bounded(pending)
    gate.reject(new Error('迟到的 MCP 错误'))
    await tick()
    assertCancelled(f)
    assert.equal(requests, 0)
    await bounded(f.chat.send('重试连接'))
    await tick()
    assert.equal(discoveries, 2)
    assert.equal(requests, 1)
    assert.equal(f.chat.error, null)
    assert.equal(f.chat.lastReason, 'complete')
  } finally {
    gate.resolve()
    if (pending) await bounded(pending)
    await f.close()
  }
})

for (const stage of ['main', 'isolated', 'summary'] as const) {
  await check(`取消 ${stage} 阶段停止 Skill 链路并保全主会话`, async () => {
    const source = skillProvider(stage)
    const f = await mount(source.provider, { skill: true })
    let pending: Promise<void> | undefined
    try {
      pending = f.chat.send('执行独立审查')
      await bounded(source.started.promise)
      f.chat.cancel()
      f.chat.cancel()
      await bounded(pending)
      await tick()
      assertCancelled(f)
      assert.deepEqual(source.calls, { main: 2, isolated: stage === 'main' ? 0 : 1, summary: stage === 'summary' ? 1 : 0 })
      assert(source.signals.at(-1)?.aborted)
      const assistant = f.history.view().find((message) => message.tool_calls?.length)
      assert(assistant?.tool_calls?.every((call) => f.history.view().some((message) => message.tool_call_id === call.id)))
      const snapshot = JSON.stringify(f.history.view())
      source.gate.resolve()
      if (stage === 'summary') await bounded(source.summaryClosed.promise)
      await tick()
      assert.equal(JSON.stringify(f.history.view()), snapshot)
      assertCancelled(f)
      await bounded(f.chat.send('继续发送'))
      await tick()
      assert.equal(f.chat.lastReason, 'complete')
      assert.equal(f.chat.error, null)
      assert(!source.signals.at(-1)?.aborted)
    } finally {
      source.gate.resolve()
      if (pending) await bounded(pending)
      await f.close()
    }
  })
}

await check('正常独立 Skill 摘要回流且不重复执行', async () => {
  const source = skillProvider()
  const f = await mount(source.provider, { skill: true })
  try {
    await bounded(f.chat.send('完成独立审查'))
    await tick()
    assert.deepEqual(source.calls, { main: 2, isolated: 1, summary: 1 })
    assert.equal(f.chat.mode, 'idle')
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(f.skillManager?.lastActivated, null)
    assert.equal(f.history.view().at(-1)?.content, '[Skill review 结果] 独立审查摘要')
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
    await bounded(f.chat.send('下一条消息'))
    assert.deepEqual(source.calls, { main: 3, isolated: 1, summary: 1 })
    assert(source.signals.every((signal) => getEventListeners(signal, 'abort').length === 0))
  } finally {
    await f.close()
  }
})

for (const scenario of ['execution-error', 'partial-execution-error', 'iteration-limit', 'summary-error'] as const) {
  await check(`独立 Skill ${scenario} 明确提示失败并保存到主会话`, async () => {
    let mainRequests = 0
    let childRequests = 0
    let summaries = 0
    let messageHooks = 0
    const hooks = new HookEngine([])
    hooks.fire = async (event) => { if (event === 'message') messageHooks++ }
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) {
        summaries++
        yield { type: 'error', message: 'SUMMARY_HTTP_500' }
      } else if (messages[0].content.includes(marker)) {
        childRequests++
        if (scenario === 'iteration-limit') yield { type: 'tool_call', id: `child-${childRequests}`, name: 'read_file', arguments: { path: childRequests } }
        else if (scenario === 'summary-error') yield { type: 'text', text: '独立执行的原始结果' }
        else {
          if (scenario === 'partial-execution-error') yield { type: 'text', text: '尚未完成的审查' }
          yield { type: 'error', message: 'CHILD_HTTP_500' }
        }
      } else {
        mainRequests++
        if (mainRequests === 1) yield { type: 'tool_call', id: 'load-review', name: 'load_skill', arguments: { name: 'review' } }
        else yield { type: 'text', text: '主流程完成' }
      }
      yield { type: 'done' }
    } }
    const f = await mount(provider, { skill: true, hooks })
    f.registry.register({ name: 'read_file', description: 'read', parameters: { type: 'object' }, async execute(args) { return { success: true, output: `子任务读取-${args.path}` } } })
    try {
      await bounded(f.chat.send('执行独立审查'))
      await tick()
      const result = f.history.view().at(-1)?.content ?? ''
      assert(result.startsWith('[Skill review 结果]'))
      if (scenario === 'summary-error') {
        assert(result.includes('执行已完成，但摘要失败：SUMMARY_HTTP_500'))
        assert(result.includes('执行输出：独立执行的原始结果'))
      } else if (scenario === 'iteration-limit') {
        assert(result.includes('执行失败：达到迭代上限（8 轮）'))
        assert(result.includes('部分输出：'))
        assert(result.includes('子任务读取-8'))
      } else {
        assert(result.includes('执行失败：CHILD_HTTP_500'))
        if (scenario === 'partial-execution-error') assert(result.includes('部分输出：尚未完成的审查'))
      }
      assert(f.chat.messages.some((message) => message.role === 'tool' && message.text.startsWith('⚠ [Skill review 结果]')))
      assert(!f.chat.messages.some((message) => message.text.startsWith('📦 [Skill review 结果]')))
      assert.equal(f.chat.mode, 'idle')
      assert.equal(f.skillManager!.lastActivated, null)
      assert.equal(summaries, scenario === 'summary-error' ? 1 : 0)
      assert.equal(childRequests, scenario === 'iteration-limit' ? 8 : 1)
      assert.equal(messageHooks, 1)
      assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
      await bounded(f.chat.send('继续发送'))
      await tick()
      assert.equal(f.chat.mode, 'idle')
      assert.equal(f.chat.error, null)
      assert.equal(summaries, scenario === 'summary-error' ? 1 : 0)
    } finally {
      await f.close()
    }
  })
}

for (const failedRead of [false, true]) {
  await check(`工具调用${failedRead ? '含失败结果' : '成功'}显示状态，并跳过额外笔记请求`, async () => {
    let requests = 0
    let notes = 0
    let executions = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content.includes('记忆整理器')) {
        notes++
        yield { type: 'text', text: '{"notes":[]}' }
      } else {
        requests++
        if (requests === 1) {
          yield { type: 'tool_call', id: 'read-good', name: 'read_file', arguments: { path: 'good' } }
          if (failedRead) yield { type: 'tool_call', id: 'read-bad', name: 'read_file', arguments: { path: 'bad' } }
        } else yield { type: 'text', text: '任务结束' }
      }
      yield { type: 'done' }
    } }
    const f = await mount(provider, { notes: true })
    f.registry.register({ name: 'read_file', description: 'read', parameters: { type: 'object' }, async execute(args) {
      executions++
      return args.path === 'bad' ? { success: false, output: '', error: '读取失败' } : { success: true, output: '读取成功' }
    } })
    try {
      await bounded(f.chat.send('调用读取工具'))
      await tick()
      assert.equal(requests, 2)
      assert.equal(executions, failedRead ? 2 : 1)
      assert.equal(notes, 0)
      assert.equal(f.chat.lastReason, 'complete')
      assert.equal(f.chat.mode, 'idle')
      assert(f.chat.messages.some((message) => message.role === 'tool' && message.text === (failedRead ? '🔧 [2] read_file ✓ · read_file ✗' : '🔧 [1] read_file ✓')))
      assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
    } finally {
      await f.close()
    }
  })
}

await check('发送准备失败保存问题并报告真实错误', async () => {
  let requests = 0
  const f = await mount({ protocol: 'openai', async *streamChat() { requests++; yield { type: 'done' } } }, { skill: true })
  try {
    f.skillManager!.activate('review')
    f.skillManager!.index = () => { throw new Error('准备阶段异常') }
    await bounded(f.chat.send('保留失败的问题'))
    await tick()
    assert.equal(requests, 0)
    assert.equal(f.chat.mode, 'idle')
    assert.equal(f.chat.lastReason, 'error')
    assert(f.chat.error?.includes('准备阶段异常'))
    assert.equal(f.skillManager!.takeNextIsolated(), undefined)
    assert.equal(f.skillManager!.lastActivated, null)
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, [{ role: 'user', content: '保留失败的问题' }])
  } finally {
    await f.close()
  }
})

await check('message Hook 等待中取消及时保存且忽略迟到拒绝', async () => {
  const started = deferred()
  const gate = deferred()
  const hooks = new HookEngine([])
  const fire = hooks.fire.bind(hooks)
  hooks.fire = async (event, context) => {
    if (event === 'message') { started.resolve(); await gate.promise }
    else await fire(event, context)
  }
  const f = await mount({ protocol: 'openai', async *streamChat() { yield { type: 'text', text: '完成' }; yield { type: 'done' } } }, { hooks })
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('取消收尾等待')
    await bounded(started.promise)
    f.chat.cancel()
    await bounded(pending)
    await tick()
    assertCancelled(f)
    gate.reject(new Error('迟到 Hook 错误'))
    await tick()
    assertCancelled(f)
  } finally {
    gate.resolve()
    if (pending) await bounded(pending)
    await f.close()
  }
})

for (const stage of ['round_start', 'tool_after', 'round_end'] as const) {
  await check(`${stage} Hook 等待中停止，UI 保存会话并允许再次发送`, async () => {
    const started = deferred()
    const gate = deferred()
    const hooks = new HookEngine([])
    let waiting = true
    hooks.fire = async (event) => {
      if (event === stage && waiting) {
        waiting = false
        started.resolve()
        await gate.promise
      }
    }
    let requests = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      requests++
      if (stage === 'tool_after' && requests === 1) yield { type: 'tool_call', id: 'load-review', name: 'load_skill', arguments: { name: 'review' } }
      else yield { type: 'text', text: '完成回复' }
      yield { type: 'done' }
    } }
    const f = await mount(provider, { hooks, skill: stage === 'tool_after' })
    let pending: Promise<void> | undefined
    try {
      pending = f.chat.send('取消 Hook 中的发送')
      await bounded(started.promise)
      f.chat.cancel()
      await bounded(pending)
      await tick()
      assertCancelled(f)
      assert.equal(requests, stage === 'round_start' ? 0 : 1)
      await bounded(f.chat.send('继续发送'))
      await tick()
      assert.equal(f.chat.mode, 'idle')
      assert.equal(f.chat.lastReason, 'complete')
      assert.equal(f.chat.error, null)
      const snapshot = JSON.stringify(f.history.view())
      gate.reject(new Error('上次 Hook 迟到拒绝'))
      await tick()
      assert.equal(JSON.stringify(f.history.view()), snapshot)
      assert.equal(f.chat.lastReason, 'complete')
    } finally {
      gate.resolve()
      if (pending) await bounded(pending)
      await f.close()
    }
  })
}

await check('取消发送也停止后台笔记请求并丢弃迟到写入', async () => {
  const noteStarted = deferred()
  const noteGate = deferred()
  const noteClosed = deferred()
  const skill = skillProvider('summary')
  let noteSignal: AbortSignal | undefined
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      if (messages[0].content.includes('记忆整理器')) {
        noteSignal = opts.signal
        noteStarted.resolve()
        try {
          await noteGate.promise
          yield { type: 'text', text: JSON.stringify({ notes: [{ title: '迟到笔记', content: '不应保存', category: 'user_pref', action: 'create' }] }) }
        } finally {
          noteClosed.resolve()
        }
      } else if (!messages[0].content.includes(marker) && !messages[0].content.startsWith('把下面的执行输出')) {
        yield { type: 'text', text: '主流程完成' }
        yield { type: 'done' }
      } else {
        yield* skill.provider.streamChat(messages, opts)
      }
    },
  }
  const f = await mount(provider, { skill: true, notes: true })
  let pending: Promise<void> | undefined
  try {
    f.skillManager!.activate('review')
    pending = f.chat.send('取消整个发送')
    await bounded(Promise.all([noteStarted.promise, skill.started.promise]))
    f.chat.cancel()
    await bounded(pending)
    await tick()
    assertCancelled(f)
    assert(noteSignal?.aborted)
    noteGate.resolve()
    skill.gate.resolve()
    await bounded(Promise.all([noteClosed.promise, skill.summaryClosed.promise]))
    await tick()
    assert(!existsSync(f.memory.noteUserDir!))
    assert(!existsSync(f.memory.noteProjectDir!))
  } finally {
    noteGate.resolve()
    skill.gate.resolve()
    if (pending) await bounded(pending)
    await f.close()
  }
})

await check('预先取消的笔记更新不启动模型请求', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(updateNotes({ protocol: 'openai', async *streamChat() { calls++; yield { type: 'done' } } }, [], {
    userDir: import.meta.dirname, projectDir: import.meta.dirname, signal: controller.signal,
  }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

function pendingNotesProvider(failSecond = false) {
  const requests: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred>; closed: ReturnType<typeof deferred>; content: string }> = []
  let mainCalls = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      if (messages[0].content.includes('记忆整理器')) {
        assert(opts.signal)
        const request = { signal: opts.signal, gate: deferred(), closed: deferred(), content: messages.filter((message) => message.role === 'user').at(-1)!.content }
        requests.push(request)
        try {
          await request.gate.promise
          yield { type: 'text', text: JSON.stringify({ notes: [{ category: 'user_pref', title: '回答偏好', content: request.content, action: 'update' }] }) }
          yield { type: 'done' }
        } finally { request.closed.resolve() }
      } else {
        if (++mainCalls === 2 && failSecond) throw new Error('新发送失败')
        yield { type: 'text', text: '收到偏好' }
        yield { type: 'done' }
      }
    },
  }
  const finish = async (request: typeof requests[number]) => {
    request.gate.resolve()
    await bounded(request.closed.promise)
    await tick()
  }
  return { provider, requests, finish, async close() { for (const request of requests) await finish(request) } }
}

await check('连续发送取消旧笔记请求，迟到旧结果不会覆盖最新偏好', async () => {
  const notes = pendingNotesProvider()
  const f = await mount(notes.provider, { notes: true })
  const file = join(f.memory.noteUserDir!, 'preference.md')
  mkdirSync(f.memory.noteUserDir!, { recursive: true })
  writeFileSync(file, '---\ncategory: user_pref\ntitle: 回答偏好\n---\n\n初始偏好\n', 'utf8')
  try {
    await bounded(f.chat.send('旧要求：详细回答'))
    await tick()
    assert.equal(notes.requests.length, 1)
    assert(!notes.requests[0].signal.aborted)
    await bounded(f.chat.send('新要求：简洁回答'))
    await tick()
    assert.equal(notes.requests.length, 2)
    assert(notes.requests[0].signal.aborted)
    assert(!notes.requests[1].signal.aborted)
    await notes.finish(notes.requests[1])
    assert(readFileSync(file, 'utf8').includes('新要求：简洁回答'))
    await notes.finish(notes.requests[0])
    assert(!readFileSync(file, 'utf8').includes('旧要求：详细回答'))
    assert.equal(readdirSync(f.memory.noteUserDir!).length, 1)
    assert.equal(f.chat.lastReason, 'complete')
  } finally { f.chat.cancel(); await notes.close(); await f.close() }
})

await check('旧任务清理后仍能取消当前笔记，已完成回答状态保持完整', async () => {
  const notes = pendingNotesProvider()
  const f = await mount(notes.provider, { notes: true })
  try {
    await bounded(f.chat.send('旧要求'))
    await tick()
    await bounded(f.chat.send('新要求'))
    await tick()
    await notes.finish(notes.requests[0])
    assert(!notes.requests[1].signal.aborted)
    f.chat.cancel()
    assert(notes.requests[1].signal.aborted)
    await notes.finish(notes.requests[1])
    assert(!existsSync(f.memory.noteUserDir!))
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(f.chat.error, null)
  } finally { f.chat.cancel(); await notes.close(); await f.close() }
})

await check('新发送失败时也丢弃上一轮未完成的笔记请求', async () => {
  const notes = pendingNotesProvider(true)
  const f = await mount(notes.provider, { notes: true })
  try {
    await bounded(f.chat.send('旧要求'))
    await tick()
    await bounded(f.chat.send('新发送失败'))
    await tick()
    assert(notes.requests[0].signal.aborted)
    assert.equal(notes.requests.length, 1)
    await notes.finish(notes.requests[0])
    assert(!existsSync(f.memory.noteUserDir!))
    assert.equal(f.chat.lastReason, 'error')
  } finally { f.chat.cancel(); await notes.close(); await f.close() }
})

for (const action of ['clear', 'new', 'resume', 'unmount'] as const) {
  await check(`${action}: 停止已结束发送的后台笔记，不落盘迟到结果`, async () => {
    const notes = pendingNotesProvider()
    const f = await mount(notes.provider, { notes: true })
    try {
      await bounded(f.chat.send('不应迟到保存的偏好'))
      await tick()
      assert.equal(notes.requests.length, 1)
      assert(!notes.requests[0].signal.aborted)
      if (action === 'clear') f.chat.clearHistory()
      else if (action === 'new') assert.equal(f.chat.newSession(), '已新建会话')
      else if (action === 'resume') {
        f.store.append('target-session', [{ role: 'user', content: '新会话内容' }])
        assert.match(f.chat.resume('target-session'), /已恢复会话/)
      } else f.unmount()
      await tick()
      assert(notes.requests[0].signal.aborted)
      await notes.finish(notes.requests[0])
      assert(!existsSync(f.memory.noteUserDir!))
      assert(!existsSync(f.memory.noteProjectDir!))
      if (action === 'resume') assert.deepEqual(f.history.view(), [{ role: 'user', content: '新会话内容' }])
    } finally { f.chat.cancel(); await notes.close(); await f.close() }
  })
}

await check('恢复不存在的会话不打断当前有效笔记更新', async () => {
  const notes = pendingNotesProvider()
  const f = await mount(notes.provider, { notes: true })
  try {
    await bounded(f.chat.send('仍应保存的偏好'))
    await tick()
    assert.equal(f.chat.resume('missing-session'), '未找到会话: missing-session')
    assert(!notes.requests[0].signal.aborted)
    await notes.finish(notes.requests[0])
    const files = readdirSync(f.memory.noteUserDir!)
    assert.equal(files.length, 1)
    assert(readFileSync(join(f.memory.noteUserDir!, files[0]), 'utf8').includes('仍应保存的偏好'))
  } finally { f.chat.cancel(); await notes.close(); await f.close() }
})

await check('Agent 父信号可取消且解除监听，局部取消不影响父信号', async () => {
  for (const kind of ['parent', 'local', 'preaborted', 'complete', 'inherited'] as const) {
    const parent = new AbortController()
    const started = deferred()
    const gate = deferred()
    let requests = 0
    if (kind === 'preaborted' || kind === 'inherited') parent.abort()
    const history = new History()
    history.push({ role: 'user', content: '取消测试' })
    const agent = runAgent({
      provider: { protocol: 'openai', async *streamChat(_messages, opts) {
        requests++
        started.resolve()
        if (kind === 'parent' || kind === 'local') await resolveOnAbort(gate.promise, opts.signal, undefined)
        yield { type: 'text', text: '完成' }
        yield { type: 'done' }
      } },
      history, registry: new ToolRegistry(), ctx: { cwd: process.cwd(), signal: parent.signal },
      ...(kind === 'inherited' ? {} : { signal: parent.signal }),
      maxIterations: 1, mode: 'full', systemPrompt: '测试', unknownToolLimit: 2,
    })
    try {
      if (kind === 'parent' || kind === 'local') {
        await bounded(started.promise)
        if (kind === 'parent') parent.abort()
        else agent.cancel()
      }
      const result = await bounded(agent.done)
      assert.equal(result.reason, kind === 'complete' || kind === 'inherited' ? 'complete' : 'cancelled')
      assert.equal(requests, kind === 'preaborted' ? 0 : 1)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      if (kind === 'local') assert(!parent.signal.aborted)
    } finally {
      gate.resolve()
      agent.cancel()
      await bounded(agent.done)
    }
  }
})

await check('共享 Skill 在同次发送的下一轮注入完整指令、收窄工具并拒绝超范围调用', async () => {
  const sharedMarker = 'SHARED-SKILL-NEXT-ROUND-INSTRUCTIONS'
  let requests = 0
  let reads = 0
  let writes = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      requests++
      if (requests === 1) {
        assert(!messages.some((message) => message.content.includes(sharedMarker)))
        yield { type: 'tool_call', id: 'load-shared', name: 'load_skill', arguments: { name: 'shared-review' } }
      } else {
        assert.equal(messages.filter((message) => message.role === 'system' && message.content.includes(sharedMarker)).length, 1)
        assert.deepEqual(opts.tools!.map((tool) => tool.function.name).sort(), ['load_skill', 'read_file'])
        if (requests === 2) {
          yield { type: 'tool_call', id: 'blocked-write', name: 'write_file', arguments: { path: 'unused', content: 'unused' } }
          yield { type: 'tool_call', id: 'allowed-read', name: 'read_file', arguments: {} }
        } else yield { type: 'text', text: '按共享指令完成审查' }
      }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    writeFileSync(join(f.root, 'skills', 'shared.md'), `---\nname: shared-review\ndescription: 共享审查\nmode: shared\ntools: [read_file]\n---\n${sharedMarker}\n`)
    f.skillManager!.loadAll()
    f.registry.register({ name: 'read_file', description: '读取', parameters: { type: 'object' }, async execute() { reads++; return { success: true, output: '读取完成' } } })
    f.registry.register({ name: 'write_file', description: '计数', parameters: { type: 'object' }, async execute() { writes++; return { success: true, output: '不应写入' } } })
    await bounded(f.chat.send('加载共享 Skill 后审查'))
    await tick()
    assert.equal(requests, 3)
    assert.equal(reads, 1)
    assert.equal(writes, 0)
    assert.equal(f.chat.lastReason, 'complete')
    assert(f.history.view().some((message) => message.tool_call_id === 'blocked-write' && message.content.includes('不在本轮允许列表')))
    assert(f.chat.messages.some((message) => message.role === 'tool' && message.text.includes('write_file ✗')))
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

await check('计划模式叠加写入共享 Skill 仍拒绝写入，不发出收尾写入指令', async () => {
  let requests = 0
  let writes = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      assert.deepEqual(opts.tools, [])
      assert(!messages.some((message) => message.content.includes('立即用 write_file 写入')))
      if (++requests === 1) yield { type: 'tool_call', id: 'plan-write', name: 'write_file', arguments: { path: 'unused', content: 'unused' } }
      else yield { type: 'text', text: '只输出计划' }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    writeFileSync(join(f.root, 'skills', 'writer.md'), '---\nname: writer\ndescription: 写入\nmode: shared\ntools: [write_file]\n---\n写入任务\n')
    f.skillManager!.loadAll()
    f.skillManager!.activate('writer')
    f.registry.register({ name: 'write_file', description: '计数', parameters: { type: 'object' }, async execute() { writes++; return { success: true, output: '' } } })
    f.chat.setUserMode('plan')
    await tick()
    await bounded(f.chat.send('制定计划'))
    await tick()
    assert.equal(f.chat.userMode, 'plan')
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(writes, 0)
    assert(f.history.view().some((message) => message.tool_call_id === 'plan-write' && message.content.includes('工具限制')))
  } finally { await f.close() }
})

await check('计划模式推迟独立 Skill 执行，切回执行模式后正常运行和摘要', async () => {
  let children = 0
  let summaries = 0
  let writes = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) {
        summaries++
        yield { type: 'text', text: '独立 Skill 已完成' }
      } else if (messages[0].content.includes(marker)) {
        if (++children === 1) yield { type: 'tool_call', id: 'child-write', name: 'write_file', arguments: { path: 'unused', content: 'unused' } }
        else yield { type: 'text', text: '独立执行完成' }
      } else yield { type: 'text', text: '主会话回答' }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    f.registry.register({ name: 'write_file', description: '计数', parameters: { type: 'object' }, async execute() { writes++; return { success: true, output: '执行完成' } } })
    f.skillManager!.activate('review')
    f.chat.setUserMode('plan')
    await tick()
    await bounded(f.chat.send('制定计划'))
    await tick()
    assert.equal(children, 0)
    assert.equal(summaries, 0)
    assert.equal(writes, 0)
    assert.equal(f.skillManager!.lastActivated?.name, 'review')
    f.chat.setUserMode('default')
    await tick()
    await bounded(f.chat.send('执行计划'))
    await tick()
    assert.equal(children, 2)
    assert.equal(summaries, 1)
    assert.equal(writes, 1)
    assert.equal(f.skillManager!.lastActivated, null)
    assert(f.history.view().some((message) => message.content.includes('[Skill review 结果] 独立 Skill 已完成')))
  } finally { await f.close() }
})

await check('取消计划阶段会清除待执行的独立 Skill，不在下次发送意外启动', async () => {
  const started = deferred()
  const gate = deferred()
  let children = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      if (messages[0].content.includes(marker) || messages[0].content.startsWith('把下面的执行输出')) children++
      started.resolve()
      await resolveOnAbort(gate.promise, opts.signal, undefined)
      yield { type: 'text', text: '回答' }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  let pending: Promise<void> | undefined
  try {
    f.skillManager!.activate('review')
    f.chat.setUserMode('plan')
    await tick()
    pending = f.chat.send('取消计划')
    await bounded(started.promise)
    f.chat.cancel()
    await bounded(pending)
    await tick()
    assertCancelled(f)
    gate.resolve()
    f.chat.setUserMode('default')
    await tick()
    await bounded(f.chat.send('下一次发送'))
    assert.equal(children, 0)
  } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
})

await check('独立 Skill 正文与工具限制只作用于子会话，写工具只执行一次', async () => {
  const isolatedMarker = 'ISOLATED-ONLY-INSTRUCTIONS'
  let main = 0
  let children = 0
  let summaries = 0
  let phase: 'main' | 'child' = 'main'
  const writes = { main: 0, child: 0 }
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      if (messages[0].content.startsWith('把下面的执行输出')) {
        summaries++
        yield { type: 'text', text: '独立操作已完成' }
      } else if (messages[0].content.includes(isolatedMarker)) {
        phase = 'child'
        assert.deepEqual(opts.tools!.map((tool) => tool.function.name).sort(), ['load_skill', 'write_file'])
        if (++children === 1) yield { type: 'tool_call', id: 'isolated-write', name: 'write_file', arguments: { path: 'unused', content: 'unused' } }
        else yield { type: 'text', text: '独立执行完成' }
      } else {
        phase = 'main'
        main++
        assert(!messages.some((message) => message.role === 'system' && message.content.includes(isolatedMarker)))
        assert(opts.tools!.some((tool) => tool.function.name === 'read_file'))
        yield { type: 'text', text: '主会话回答' }
      }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    writeFileSync(join(f.root, 'skills', 'isolated.md'), `---\nname: isolated-write\ndescription: 独立操作\nmode: isolated\nhistory: 0\ntools: [write_file]\n---\n${isolatedMarker}\n`)
    f.skillManager!.loadAll()
    f.skillManager!.activate('isolated-write')
    f.registry.register({ name: 'read_file', description: '读取计数', parameters: { type: 'object' }, async execute() { return { success: true, output: '' } } })
    f.registry.register({ name: 'write_file', description: '写入计数', parameters: { type: 'object' }, async execute() { writes[phase]++; return { success: true, output: '执行完成' } } })
    await bounded(f.chat.send('运行独立操作'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    assert.deepEqual(writes, { main: 0, child: 1 })
    assert.equal(children, 2)
    assert.equal(summaries, 1)
    assert(f.history.view().some((message) => message.content.includes('[Skill isolated-write 结果] 独立操作已完成')))
    await bounded(f.chat.send('下一项主会话任务'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(main, 2)
    assert.deepEqual(writes, { main: 0, child: 1 })
    assert.equal(children, 2)
  } finally { await f.close() }
})

await check('共享 Skill 的显式空白名单只保留 load_skill，写入调用在执行端被拒绝', async () => {
  const sharedMarker = 'EMPTY-SHARED-ALLOWLIST'
  let requests = 0
  let writes = 0
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      assert(messages.some((message) => message.role === 'system' && message.content.includes(sharedMarker)))
      assert.deepEqual(opts.tools!.map((tool) => tool.function.name), ['load_skill'])
      if (++requests === 1) yield { type: 'tool_call', id: 'empty-list-write', name: 'write_file', arguments: { path: 'unused', content: 'unused' } }
      else yield { type: 'text', text: '只返回结论' }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    writeFileSync(join(f.root, 'skills', 'empty.md'), `---\nname: empty\ndescription: 无工具\nmode: shared\ntools: []\n---\n${sharedMarker}\n`)
    f.skillManager!.loadAll()
    f.skillManager!.activate('empty')
    f.registry.register({ name: 'write_file', description: '写入计数', parameters: { type: 'object' }, async execute() { writes++; return { success: true, output: '' } } })
    await bounded(f.chat.send('无工具完成任务'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(requests, 2)
    assert.equal(writes, 0)
    assert(f.history.view().some((message) => message.tool_call_id === 'empty-list-write' && message.content.includes('不在本轮允许列表')))
    assert(f.chat.messages.some((message) => message.role === 'tool' && message.text.includes('write_file ✗')))
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

for (const action of ['same', 'clear', 'new', 'resume'] as const) {
  await check(`计划上下文在 ${action} 场景下只属于当前会话，且执行后只消费一次`, async () => {
    const planMarker = `SESSION-PLAN-${action}-MARKER`
    const requests: string[] = []
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages) {
        assert.equal(messages.some((message) => message.content.includes('当前处于计划模式')), requests.length === 0)
        requests.push(messages[0].content)
        yield { type: 'text', text: requests.length === 1 ? planMarker : '当前会话回答' }
        yield { type: 'done' }
      },
    }
    const f = await mount(provider)
    try {
      f.chat.setUserMode('plan')
      await waitForState(() => f.chat.agentMode === 'plan')
      await bounded(f.chat.send('制定当前会话计划'))
      await tick()
      assert.equal(f.chat.lastReason, 'complete')
      if (action === 'clear') f.chat.clearHistory()
      else if (action === 'new') assert.equal(f.chat.newSession(), '已新建会话')
      else if (action === 'resume') {
        f.store.append('target-session', [{ role: 'user', content: '目标会话的问题' }])
        assert(f.chat.resume('target-session').startsWith('已恢复会话'))
      }
      await tick()
      if (action !== 'same') {
        assert(!f.history.view().some((message) => message.content.includes(planMarker)))
        assert(!f.chat.messages.some((message) => message.text.includes(planMarker)))
      }
      f.chat.setUserMode('default')
      await waitForState(() => f.chat.agentMode === 'full')
      await bounded(f.chat.send('执行当前会话任务'))
      await tick()
      assert.equal(f.chat.lastReason, 'complete')
      assert.equal(requests.length, 2)
      assert.equal(requests[1].includes(planMarker), action === 'same')
      await bounded(f.chat.send('后续任务'))
      await tick()
      assert.equal(f.chat.lastReason, 'complete')
      assert.equal(requests.length, 3)
      assert(!requests[2].includes(planMarker))
    } finally { await f.close() }
  })
}

function loadQueuedSkills(f: Awaited<ReturnType<typeof mount>>): void {
  for (const name of ['queue-a', 'queue-b']) {
    writeFileSync(join(f.root, 'skills', `${name}.md`), `---\nname: ${name}\ndescription: 排队任务\nmode: isolated\nhistory: 0\n---\nQUEUE-INSTRUCTIONS-${name}\n`)
  }
  writeFileSync(join(f.root, 'skills', 'queue-shared.md'), '---\nname: queue-shared\ndescription: 共享任务\nmode: shared\n---\n共享任务说明\n')
  f.skillManager!.loadAll()
}

for (const failFirst of [false, true]) {
  await check(`同轮两个独立 Skill 与共享 Skill 激活后按顺序执行，首项${failFirst ? '失败仍继续' : '成功不遗漏'}且不重复执行`, async () => {
    const children: string[] = []
    let main = 0
    let summaries = 0
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages) {
        if (messages[0].content.startsWith('把下面的执行输出')) {
          summaries++
          yield { type: 'text', text: `摘要-${children.at(-1)}` }
        } else if (messages[0].content.includes('QUEUE-INSTRUCTIONS-')) {
          const name = messages[0].content.includes('QUEUE-INSTRUCTIONS-queue-a') ? 'queue-a' : 'queue-b'
          children.push(name)
          assert(messages.every((message) => message.role === 'system'))
          if (failFirst && name === 'queue-a') yield { type: 'error', message: 'QUEUE_A_FAILED' }
          else yield { type: 'text', text: `完成-${name}` }
        } else if (++main === 1) {
          for (const name of ['queue-a', 'queue-b', 'queue-shared']) {
            yield { type: 'tool_call', id: `load-${name}`, name: 'load_skill', arguments: { name } }
          }
        } else yield { type: 'text', text: '主任务已完成' }
        yield { type: 'done' }
      },
    }
    const f = await mount(provider, { skill: true })
    try {
      loadQueuedSkills(f)
      await bounded(f.chat.send('执行两项独立任务'))
      await tick()
      assert.equal(f.chat.lastReason, 'complete')
      assert.deepEqual(children, ['queue-a', 'queue-b'])
      assert.equal(summaries, failFirst ? 1 : 2)
      const first = f.history.view().find((message) => message.content.startsWith('[Skill queue-a 结果]'))
      assert(first?.content.includes(failFirst ? '执行失败：QUEUE_A_FAILED' : '摘要-queue-a'))
      assert(f.history.view().some((message) => message.content.startsWith('[Skill queue-b 结果] 摘要-queue-b')))
      assert(f.chat.messages.some((message) => message.text.includes('[Skill queue-b 结果]')))
      assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
      assert.equal(f.skillManager!.lastActivated, null)
      await bounded(f.chat.send('后续主任务'))
      await tick()
      assert.deepEqual(children, ['queue-a', 'queue-b'])
      assert.equal(main, 3)
    } finally { await f.close() }
  })
}

await check('首个独立任务取消后清空队列，后续发送不会执行剩余任务', async () => {
  const started = deferred()
  const gate = deferred()
  const children: string[] = []
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages, opts) {
      if (messages[0].content.includes('QUEUE-INSTRUCTIONS-')) {
        const name = messages[0].content.includes('QUEUE-INSTRUCTIONS-queue-a') ? 'queue-a' : 'queue-b'
        children.push(name)
        started.resolve()
        await resolveOnAbort(gate.promise, opts.signal, undefined)
        yield { type: 'text', text: '已取消任务的迟到输出' }
      } else yield { type: 'text', text: '主任务完成' }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  let pending: Promise<void> | undefined
  try {
    loadQueuedSkills(f)
    f.skillManager!.activate('queue-a')
    f.skillManager!.activate('queue-b')
    pending = f.chat.send('运行队列')
    await bounded(started.promise)
    f.chat.cancel()
    await bounded(pending)
    await tick()
    assertCancelled(f)
    assert(!f.history.view().some((message) => message.content.startsWith('[Skill queue-')))
    assert.deepEqual(children, ['queue-a'])
    assert.equal(f.skillManager!.takeNextIsolated(), undefined)
    gate.resolve()
    await bounded(f.chat.send('取消后的新任务'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    assert.deepEqual(children, ['queue-a'])
  } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
})

await check('计划模式保留完整独立任务队列，切换执行模式后依次运行', async () => {
  const children: string[] = []
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) yield { type: 'text', text: '排队任务摘要' }
      else if (messages[0].content.includes('QUEUE-INSTRUCTIONS-')) {
        children.push(messages[0].content.includes('QUEUE-INSTRUCTIONS-queue-a') ? 'queue-a' : 'queue-b')
        yield { type: 'text', text: '执行完成' }
      } else yield { type: 'text', text: '当前模式的主任务结果' }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    loadQueuedSkills(f)
    f.skillManager!.activate('queue-a')
    f.skillManager!.activate('queue-b')
    f.chat.setUserMode('plan')
    await waitForState(() => f.chat.agentMode === 'plan')
    await bounded(f.chat.send('先制定计划'))
    await tick()
    assert.deepEqual(children, [])
    f.chat.setUserMode('default')
    await waitForState(() => f.chat.agentMode === 'full')
    await bounded(f.chat.send('执行计划'))
    await tick()
    assert.deepEqual(children, ['queue-a', 'queue-b'])
    assert.equal(f.skillManager!.takeNextIsolated(), undefined)
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

await check('独立 Skill 的 usage 不覆盖主会话预算', async () => {
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(messages) {
      if (messages[0].content.startsWith('把下面的执行输出')) yield { type: 'text', text: '独立任务摘要' }
      else if (messages[0].content.includes(marker)) {
        yield { type: 'usage', inputTokens: 8000, outputTokens: 10 }
        yield { type: 'text', text: '独立任务完成' }
      } else {
        yield { type: 'usage', inputTokens: 26000, outputTokens: 10 }
        yield { type: 'text', text: '主任务完成' }
      }
      yield { type: 'done' }
    },
  }
  const f = await mount(provider, { skill: true })
  try {
    for (let i = 0; i < 35; i++) f.history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '历史'.repeat(500) })
    f.store.append(f.memory.sessionId, f.history.all())
    assert.match(f.chat.resume(f.memory.sessionId), /已恢复会话/)
    f.skillManager!.activate('review')
    await bounded(f.chat.send('执行独立任务并保持主预算'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    const budget = f.chat.getToolContext().contextBudget!()
    assert.equal(budget.lastInputTokens, 26000)
    assert.equal(budget.historyMessages, f.history.length)
    assert(budget.estimatedTokens >= 26000)
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

await check('独立 Skill 嵌套加载共享 Skill 后，指令和工具范围只在子会话生效，主会话后续照常执行', async () => {
  const nestedMarker = 'NESTED-LOCAL-ONLY-INSTRUCTIONS'
  let main = 0
  let child = 0
  const calls = { read: 0, write: 0 }
  const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
    if (messages[0].content.startsWith('把下面的执行输出')) yield { type: 'text', text: '嵌套任务摘要' }
    else if (messages[0].content.includes(marker)) {
      if (++child === 1) yield { type: 'tool_call', id: 'child-load-shared', name: 'load_skill', arguments: { name: 'nested-local' } }
      else {
        assert(messages.some((message) => message.role === 'system' && message.content.includes(nestedMarker)))
        assert.deepEqual(options.tools!.map((tool) => tool.function.name), ['load_skill'])
        if (child === 2) {
          yield { type: 'tool_call', id: 'child-read-denied', name: 'read_file', arguments: {} }
          yield { type: 'tool_call', id: 'child-write-denied', name: 'write_file', arguments: {} }
        } else yield { type: 'text', text: '子会话完成' }
      }
    } else {
      main++
      assert(!messages.some((message) => message.role === 'system' && message.content.includes(nestedMarker)))
      assert(options.tools!.some((tool) => tool.function.name === 'write_file'))
      if (main === 1) yield { type: 'tool_call', id: 'main-load-review', name: 'load_skill', arguments: { name: 'review' } }
      else if (main === 3) {
        yield { type: 'tool_call', id: 'main-read', name: 'read_file', arguments: {} }
        yield { type: 'tool_call', id: 'main-write', name: 'write_file', arguments: {} }
      } else yield { type: 'text', text: '主会话完成' }
    }
    yield { type: 'done' }
  } }
  const f = await mount(provider, { skill: true })
  try {
    writeFileSync(join(f.root, 'skills', 'nested-local.md'), `---\nname: nested-local\ndescription: 子会话共享任务\nmode: shared\ntools: []\n---\n${nestedMarker}\n`)
    f.skillManager!.loadAll()
    for (const name of ['read_file', 'write_file']) f.registry.register({ name, description: name, parameters: { type: 'object' }, async execute() {
      if (name === 'read_file') calls.read++; else calls.write++
      return { success: true, output: '执行完成' }
    } })
    await bounded(f.chat.send('先执行独立审查'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    assert.equal(child, 3)
    assert.deepEqual(calls, { read: 0, write: 0 })
    assert.equal(f.skillManager!.isActive('nested-local'), false)
    assert.equal(f.skillManager!.activePrompt(), '')
    assert.equal(f.skillManager!.activeToolNames(), null)
    await bounded(f.chat.send('继续主会话任务'))
    await tick()
    assert.equal(f.chat.lastReason, 'complete')
    assert.deepEqual(calls, { read: 1, write: 1 })
    assert.equal(f.skillManager!.takeNextIsolated(), undefined)
    assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
  } finally { await f.close() }
})

for (const stop of ['cancelled', 'error', 'max_iterations', 'unknown_tool', 'tool_failures', 'tool_repeat'] as const) {
  await check(`${stop} 的半成品计划不注入下一次执行`, async () => {
    const partial = `UNFINISHED-PLAN-${stop}`
    const started = deferred()
    const gate = deferred()
    const executionPrompts: string[] = []
    let rounds = 0
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(messages, options) {
        if (isPlanRequest(messages)) {
          rounds++
          yield { type: 'text', text: partial }
          if (stop === 'cancelled') {
            started.resolve()
            await resolveOnAbort(gate.promise, options.signal, undefined)
          } else if (stop === 'error') yield { type: 'error', message: 'PLAN-STREAM-ERROR' }
          else yield {
            type: 'tool_call', id: `plan-${rounds}`,
            name: stop === 'unknown_tool' ? 'missing_plan_tool' : stop === 'tool_repeat' ? 'load_skill' : 'read_file',
            arguments: stop === 'tool_repeat' ? { name: 'repeat' } : { round: rounds },
          }
          if (stop === 'tool_repeat') yield { type: 'tool_call', id: `read-${rounds}`, name: 'read_file', arguments: { round: rounds } }
        } else {
          executionPrompts.push(messages[0].content)
          yield { type: 'text', text: '执行完成' }
        }
        yield { type: 'done' }
      },
    }
    const f = await mount(provider)
    let pending: Promise<void> | undefined
    try {
      f.registry.register({ name: 'read_file', description: '计划检查', parameters: { type: 'object' }, async execute() {
        return stop === 'tool_failures' ? { success: false, output: '', error: 'PLAN-READ-ERROR' } : { success: true, output: '检查完成' }
      } })
      f.registry.register({ name: 'load_skill', description: '重复加载', parameters: { type: 'object' }, async execute() { return { success: true, output: '重复检查' } } })
      f.chat.setUserMode('plan')
      await waitForState(() => f.chat.agentMode === 'plan')
      pending = f.chat.send('制定计划')
      if (stop === 'cancelled') {
        await bounded(started.promise)
        await waitForState(() => f.chat.messages.some((message) => message.text.includes(partial)))
        f.chat.cancel()
      }
      await bounded(pending)
      await tick()
      assert.equal(f.chat.lastReason, stop)
      assert(f.chat.messages.some((message) => message.text.includes(partial)))
      gate.resolve()
      f.chat.setUserMode('default')
      await waitForState(() => f.chat.agentMode === 'full')
      await bounded(f.chat.send('执行新的任务'))
      await tick()
      assert.equal(f.chat.lastReason, 'complete')
      assert.equal(executionPrompts.length, 1)
      assert(!executionPrompts[0].includes(partial))
      assert(!executionPrompts[0].includes('你已制定的计划'))
    } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
  })
}

await check('计划正常输出后在收尾阶段取消，也不提交可执行计划', async () => {
  const hooks = new HookEngine([])
  const started = deferred()
  const gate = deferred()
  const marker = 'PLAN-CANCELLED-DURING-FINALIZATION'
  let first = true
  let executionPrompt = ''
  hooks.fire = async (event, _context, signal) => {
    if (event === 'message' && first) {
      first = false
      started.resolve()
      await resolveOnAbort(gate.promise, signal, undefined)
    }
  }
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (isPlanRequest(messages)) yield { type: 'text', text: marker }
    else { executionPrompt = messages[0].content; yield { type: 'text', text: '新任务完成' } }
    yield { type: 'done' }
  } }
  const f = await mount(provider, { hooks })
  let pending: Promise<void> | undefined
  try {
    f.chat.setUserMode('plan')
    await waitForState(() => f.chat.agentMode === 'plan')
    pending = f.chat.send('先制定计划')
    await bounded(started.promise)
    f.chat.cancel()
    await bounded(pending)
    await tick()
    assertCancelled(f)
    f.chat.setUserMode('default')
    await waitForState(() => f.chat.agentMode === 'full')
    await bounded(f.chat.send('新任务'))
    assert(!executionPrompt.includes(marker))
  } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
})

await check('正常完成的新计划替换旧计划，失败的新尝试不会恢复旧计划', async () => {
  let attempts = 0
  const executionPrompts: string[] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    if (isPlanRequest(messages)) {
      attempts++
      yield { type: 'text', text: `COMPLETED-PLAN-${attempts}` }
      if (attempts === 3 || attempts === 5) yield { type: 'error', message: '计划失败' }
    } else { executionPrompts.push(messages[0].content); yield { type: 'text', text: '执行完成' } }
    yield { type: 'done' }
  } }
  const f = await mount(provider)
  try {
    f.chat.setUserMode('plan')
    await waitForState(() => f.chat.agentMode === 'plan')
    await bounded(f.chat.send('第一版计划'))
    await bounded(f.chat.send('第二版计划'))
    f.chat.setUserMode('default')
    await waitForState(() => f.chat.agentMode === 'full')
    await bounded(f.chat.send('执行第二版'))
    assert(executionPrompts[0].includes('COMPLETED-PLAN-2'))
    assert(!executionPrompts[0].includes('COMPLETED-PLAN-1'))
    await bounded(f.chat.send('失败的新计划', { modeOverride: 'plan' }))
    await bounded(f.chat.send('新的完成计划', { modeOverride: 'plan' }))
    await bounded(f.chat.send('替换计划失败', { modeOverride: 'plan' }))
    await bounded(f.chat.send('失败后执行新任务'))
    assert(!executionPrompts[1].includes('你已制定的计划'))
  } finally { await f.close() }
})

await check('/clear 清理当前会话、当前 Agent 待注入 Hook，同时保留其他会话与全局提示', async () => {
  const hooks = new HookEngine([
    { event: 'round_end', once: true, action: { type: 'inject_prompt', content: 'OLD-CURRENT-HOOK' } },
    { event: 'session_start', action: { type: 'inject_prompt', content: 'SESSION-HOOK' } },
    { event: 'subagent_start', action: { type: 'inject_prompt', content: 'AGENT-HOOK' } },
    { event: 'app_start', action: { type: 'inject_prompt', content: 'GLOBAL-HOOK' } },
  ])
  const requests: string[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    requests.push(messages.filter((message) => message.role === 'system').map((message) => message.content))
    yield { type: 'text', text: '任务完成' }; yield { type: 'done' }
  } }
  const f = await mount(provider, { hooks })
  try {
    await bounded(f.chat.send('旧任务'))
    const context = f.chat.getToolContext()
    await hooks.fire('session_start', { cwd: f.root, sessionId: context.sessionId })
    await hooks.fire('subagent_start', { cwd: f.root, agentId: context.agentId })
    await hooks.fire('session_start', { cwd: f.root, sessionId: 'other-session', agentId: 'other-agent' })
    await hooks.fire('app_start', { cwd: f.root })
    f.chat.clearHistory()
    await tick()
    assert.equal(f.history.length, 0)
    assert.equal(f.chat.messages.length, 0)
    await bounded(f.chat.send('清空后的新任务'))
    const injected = requests[1].join('\n')
    assert(!injected.includes('OLD-CURRENT-HOOK'))
    assert(!injected.includes('SESSION-HOOK'))
    assert(!injected.includes('AGENT-HOOK'))
    assert(injected.includes('GLOBAL-HOOK'))
    assert.deepEqual(hooks.collectInjections({ sessionId: 'other-session', agentId: 'other-agent' }), ['SESSION-HOOK'])
  } finally { await f.close() }
})

await check('/clear 后晚到的 Hook 注入租约回退不会恢复旧指令，执行中清空不丢待注入状态', async () => {
  const hooks = new HookEngine([{ event: 'round_end', action: { type: 'inject_prompt', content: 'LEASED-OLD-HOOK' } }])
  const started = deferred()
  const gate = deferred()
  let requests = 0
  const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    if (++requests === 1) { started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined) }
    yield { type: 'text', text: '完成' }; yield { type: 'done' }
  } }
  const f = await mount(provider, { hooks })
  let pending: Promise<void> | undefined
  try {
    pending = f.chat.send('活动任务')
    await bounded(started.promise)
    const context = f.chat.getToolContext()
    await hooks.fire('round_end', { cwd: f.root, sessionId: context.sessionId, agentId: context.agentId })
    f.chat.clearHistory()
    assert.equal(f.history.length, 1)
    assert.deepEqual(hooks.collectInjections(context), ['LEASED-OLD-HOOK'])
    gate.resolve()
    await bounded(pending)
    const currentLease = hooks.checkoutInjections(context)
    await hooks.fire('round_end', { cwd: f.root, sessionId: 'other-session', agentId: 'other-agent' })
    const otherLease = hooks.checkoutInjections({ sessionId: 'other-session', agentId: 'other-agent' })
    f.chat.clearHistory()
    currentLease.rollback()
    otherLease.rollback()
    assert.deepEqual(hooks.collectInjections(context), [])
    assert.deepEqual(hooks.collectInjections({ sessionId: 'other-session', agentId: 'other-agent' }), ['LEASED-OLD-HOOK'])
  } finally { gate.resolve(); if (pending) await bounded(pending); await f.close() }
})

for (const mode of ['default', 'plan'] as const) {
  for (const stop of ['error', 'max_iterations', 'unknown_tool', 'tool_failures', 'tool_repeat'] as const) {
    await check(`${mode} 主流程以 ${stop} 结束后不执行排队独立 Skill，后续发送也不补跑`, async () => {
      let failing = true
      let mainRounds = 0
      let children = 0
      let summaries = 0
      let writes = 0
      const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
        if (messages[0].content.startsWith('把下面的执行输出')) { summaries++; yield { type: 'text', text: '不应摘要' } }
        else if (messages[0].content.includes(marker)) {
          children++
          yield { type: 'tool_call', id: `unexpected-write-${children}`, name: 'write_file', arguments: {} }
        } else if (!failing) yield { type: 'text', text: '下一任务完成' }
        else {
          mainRounds++
          if (mode === 'default' && mainRounds === 1) {
            yield { type: 'tool_call', id: 'queue-review', name: 'load_skill', arguments: { name: 'review' } }
          } else {
            yield { type: 'text', text: '未完成的主流程' }
            if (stop === 'error') yield { type: 'error', message: 'MAIN-PROVIDER-FAILED' }
            else {
              yield {
                type: 'tool_call', id: `stop-${mainRounds}`,
                name: stop === 'unknown_tool' ? 'missing_main_tool' : stop === 'tool_repeat' ? 'load_skill' : 'read_file',
                arguments: stop === 'tool_repeat' ? { name: 'review' } : { round: mainRounds },
              }
              if (mode === 'plan' && stop === 'tool_repeat') yield { type: 'tool_call', id: `read-${mainRounds}`, name: 'read_file', arguments: { round: mainRounds } }
            }
          }
        }
        yield { type: 'done' }
      } }
      const f = await mount(provider, { skill: true })
      try {
        f.registry.register({ name: 'write_file', description: '不应写入', parameters: { type: 'object' }, async execute() { writes++; return { success: true, output: '不应执行' } } })
        f.registry.register({ name: 'read_file', description: '主流程读取', parameters: { type: 'object' }, async execute() {
          return failing && stop === 'tool_failures' ? { success: false, output: '', error: 'MAIN-READ-FAILED' } : { success: true, output: '读取完成' }
        } })
        if (mode === 'plan') {
          f.skillManager!.activate('review')
          f.chat.setUserMode('plan')
          await waitForState(() => f.chat.agentMode === 'plan')
        }
        await bounded(f.chat.send('排队后让主流程失败'))
        await tick()
        assert.equal(f.chat.lastReason, stop)
        assert.equal(children, 0)
        assert.equal(summaries, 0)
        assert.equal(writes, 0)
        assert.equal(f.skillManager!.lastActivated, null)
        assert.equal(f.skillManager!.takeNextIsolated(), undefined)
        assert(!f.history.view().some((message) => message.content.includes('[Skill review 结果]')))
        assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
        failing = false
        f.chat.setUserMode('default')
        await waitForState(() => f.chat.agentMode === 'full')
        await bounded(f.chat.send('开始下一任务'))
        await tick()
        assert.equal(f.chat.lastReason, 'complete')
        assert.equal(children, 0)
        assert.equal(summaries, 0)
        assert.equal(writes, 0)
        assert.deepEqual(f.store.recoverById(f.memory.sessionId)?.messages, f.history.view())
      } finally { await f.close() }
    })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
