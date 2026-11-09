import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import type { Provider } from '../src/provider/types.ts'
import { runIsolated, SkillRunError } from '../src/skill/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { browserTool, closeAllBrowserScopes } from '../src/tools/browser.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0
let failed = 0
const browsers: { closed: number }[] = []
function fakeBrowser(failClose = false): Browser {
  const record = { closed: 0 }
  browsers.push(record)
  let disconnected: (() => void) | undefined
  return {
    newPage: async () => ({ evaluate: async () => 'BROWSER-SCOPE-ALIVE' }),
    close: async () => {
      record.closed++
      if (failClose) throw new Error('BROWSER-CLOSE-ERROR')
      disconnected?.()
    },
    on: (_event: string, listener: () => void) => { disconnected = listener },
  } as unknown as Browser
}
const originalLaunch = chromium.launch
const normalLaunch = async () => fakeBrowser()
chromium.launch = normalLaunch

async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${String(error)}`) }
  finally { await closeAllBrowserScopes(); chromium.launch = normalLaunch }
}
const plain: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'text', text: 'DONE' }; yield { type: 'done' } } }
const launch = async (ctx: ToolContext) => assert.equal((await browserTool.execute({ action: 'launch' }, ctx)).success, true)
const alive = async (ctx: ToolContext) => (await browserTool.execute({ action: 'eval', expr: '1' }, { ...ctx, signal: undefined })).success

try {
  for (const action of ['clear', 'new', 'resume-current', 'resume-other', 'unmount']) {
    await check(`TUI ${action} 回收真实 Agent 浏览器，其他 Agent 保持可用`, async () => {
      const f = await streamFixture(plain)
      try {
        const ctx = f.chat.getToolContext()
        const peer = { ...ctx, agentId: 'peer-browser' }
        await launch(ctx); await launch(peer)
        const own = browsers.at(-2)!
        const other = browsers.at(-1)!
        f.store.replace(f.memory.sessionId, [{ role: 'user', content: 'ORIGINAL' }])
        f.store.replace('other-session', [{ role: 'user', content: 'OTHER' }])
        if (action === 'clear') f.chat.clearHistory()
        else if (action === 'new') f.chat.newSession()
        else if (action === 'resume-current') f.chat.resume(f.memory.sessionId)
        else if (action === 'resume-other') f.chat.resume('other-session')
        else await f.unmount()
        await tick(); await tick()
        assert.equal(own.closed, 1)
        assert.equal(await alive(ctx), false)
        assert.equal(other.closed, 0)
        assert.equal(await alive(peer), true)
      } finally { await closeAllBrowserScopes(); await f.close() }
    })
  }

  await check('恢复不存在的会话或切换回调失败时，保留当前浏览器', async () => {
    const f = await streamFixture(plain, { onSessionChange() { throw new Error('SWITCH-FAIL') } })
    try {
      const ctx = f.chat.getToolContext()
      await launch(ctx)
      assert.match(f.chat.resume('missing-session'), /未找到/)
      assert.match(f.chat.newSession(), /SWITCH-FAIL/)
      await tick()
      assert.equal(browsers.at(-1)!.closed, 0)
      assert.equal(await alive(ctx), true)
    } finally { await f.close() }
  })

  await check('主会话正常发送后浏览器可跨轮复用，退出时再关闭', async () => {
    const f = await streamFixture(plain)
    try {
      const ctx = f.chat.getToolContext()
      await launch(ctx)
      const browser = browsers.at(-1)!
      await bounded(f.chat.send('one')); await bounded(f.chat.send('two'))
      assert.equal(browser.closed, 0)
      assert.equal(await alive(ctx), true)
      await f.unmount()
      assert.equal(browser.closed, 1)
    } finally { await f.close() }
  })

  for (const outcome of ['done', 'error', 'cancelled']) {
    await check(`子 Agent ${outcome} 回收自己的浏览器，保留父会话浏览器`, async () => {
      const started = deferred()
      const gate = deferred()
      let rounds = 0
      let childCtx: ToolContext | undefined
      const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
        if (++rounds === 1) yield { type: 'tool_call', id: 'child-browser', name: 'browser', arguments: { action: 'launch' } }
        else {
          started.resolve()
          if (outcome === 'cancelled') await resolveOnAbort(gate.promise, options.signal, undefined)
          if (outcome === 'error') yield { type: 'error', message: 'CHILD-BROWSER-ERROR' }
          else yield { type: 'text', text: 'CHILD-DONE' }
        }
        yield { type: 'done' }
      } }
      const f = await streamFixture(provider)
      f.registry.register({ ...browserTool, async execute(args, ctx) { childCtx = ctx; return browserTool.execute(args, ctx) } })
      try {
        const parent = f.chat.getToolContext()
        await launch(parent)
        const parentBrowser = browsers.at(-1)!
        const id = await f.child('browser-child', 'fork')
        await bounded(started.promise)
        if (outcome === 'cancelled') assert(f.manager.cancel(id))
        const record = await f.finished(id)
        assert.equal(record.status, outcome)
        assert(childCtx)
        assert.notEqual(childCtx.agentId, parent.agentId)
        assert.equal(browsers.at(-1)!.closed, 1)
        assert.equal(await alive(childCtx), false)
        assert.equal(parentBrowser.closed, 0)
        assert.equal(await alive(parent), true)
      } finally { gate.resolve(); await closeAllBrowserScopes(); await f.close() }
    })
  }

  for (const outcome of ['done', 'summary-error', 'cancelled']) {
    await check(`独立 Skill ${outcome} 回收自身浏览器，保留主会话浏览器`, async () => {
      const started = deferred()
      const gate = deferred()
      const controller = new AbortController()
      let rounds = 0
      let childCtx: ToolContext | undefined
      const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
        if (messages[0].content.startsWith('把下面的执行输出')) {
          if (outcome === 'summary-error') yield { type: 'error', message: 'SKILL-SUMMARY-ERROR' }
          else yield { type: 'text', text: 'SKILL-SUMMARY' }
        } else if (++rounds === 1) yield { type: 'tool_call', id: 'skill-browser', name: 'browser', arguments: { action: 'launch' } }
        else {
          started.resolve()
          if (outcome === 'cancelled') await resolveOnAbort(gate.promise, options.signal, undefined)
          yield { type: 'text', text: 'SKILL-DONE' }
        }
        yield { type: 'done' }
      } }
      const f = await streamFixture(provider)
      f.registry.register({ ...browserTool, async execute(args, ctx) { childCtx = ctx; return browserTool.execute(args, ctx) } })
      let running: Promise<string> | undefined
      try {
        const parent = f.chat.getToolContext()
        await launch(parent)
        const parentBrowser = browsers.at(-1)!
        running = runIsolated({ name: 'browser-skill', description: '回收回归', mode: 'isolated', content: 'BROWSER-SKILL', source: 'project' }, f.history, {
          provider, registry: f.registry, ctx: parent, signal: controller.signal, systemPrompt: 'SKILL-BASE',
        })
        const settled = running.then((value) => ({ value }), (error: unknown) => ({ error }))
        await bounded(started.promise)
        if (outcome === 'cancelled') controller.abort()
        const result = await bounded(settled)
        if (outcome === 'done') assert('value' in result && result.value === 'SKILL-SUMMARY')
        else if (outcome === 'summary-error') assert('error' in result && result.error instanceof SkillRunError && result.error.stage === 'summary')
        else assert('error' in result && result.error instanceof Error && result.error.name === 'AbortError')
        await tick()
        assert(childCtx)
        assert.equal(browsers.at(-1)!.closed, 1)
        assert.equal(await alive(childCtx), false)
        assert.equal(parentBrowser.closed, 0)
        assert.equal(await alive(parent), true)
      } finally { controller.abort(); gate.resolve(); await running?.catch(() => {}); await closeAllBrowserScopes(); await f.close() }
    })
  }

  await check('取消正在启动浏览器的子任务立即返回，迟到的浏览器只关闭一次', async () => {
    const started = deferred()
    const gate = deferred()
    let childCtx: ToolContext | undefined
    let rounds = 0
    chromium.launch = async () => { started.resolve(); await gate.promise; return fakeBrowser() }
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++rounds === 1) yield { type: 'tool_call', id: 'late-browser', name: 'browser', arguments: { action: 'launch' } }
      else yield { type: 'text', text: 'LATE-DONE' }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    f.registry.register({ ...browserTool, async execute(args, ctx) { childCtx = ctx; return browserTool.execute(args, ctx) } })
    try {
      const id = await f.child('late-browser-child', 'fork')
      await bounded(started.promise)
      assert(f.manager.cancel(id))
      assert.equal((await f.finished(id)).status, 'cancelled')
      gate.resolve()
      await bounded(closeAllBrowserScopes())
      assert(childCtx)
      assert.equal(browsers.at(-1)!.closed, 1)
      assert.equal(await alive(childCtx), false)
    } finally { gate.resolve(); await closeAllBrowserScopes(); await f.close() }
  })

  await check('浏览器关闭异常不掩盖子任务结果或残留可用作用域', async () => {
    chromium.launch = async () => fakeBrowser(true)
    let rounds = 0
    let childCtx: ToolContext | undefined
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message) => warnings.push(String(message))
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++rounds === 1) yield { type: 'tool_call', id: 'bad-close', name: 'browser', arguments: { action: 'launch' } }
      else yield { type: 'text', text: 'CHILD-COMPLETE' }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    f.registry.register({ ...browserTool, async execute(args, ctx) { childCtx = ctx; return browserTool.execute(args, ctx) } })
    try {
      const record = await f.finished(await f.child('bad-close-child', 'fork'))
      assert.equal(record.status, 'done')
      assert(record.result?.includes('CHILD-COMPLETE'))
      assert(warnings.some((message) => message.includes('BROWSER-CLOSE-ERROR')))
      assert(childCtx)
      assert.equal(await alive(childCtx), false)
      assert.equal(browsers.at(-1)!.closed, 1)
    } finally { console.warn = originalWarn; await f.close() }
  })

  await check('TUI 卸载取消正在启动浏览器的主发送，并回收迟到的浏览器', async () => {
    const started = deferred()
    const gate = deferred()
    let launchedCtx: ToolContext | undefined
    chromium.launch = async () => { started.resolve(); await gate.promise; return fakeBrowser() }
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      yield { type: 'tool_call', id: 'unmount-browser', name: 'browser', arguments: { action: 'launch' } }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider)
    f.registry.register({ ...browserTool, async execute(args, ctx) { launchedCtx = ctx; return browserTool.execute(args, ctx) } })
    let running: Promise<void> | undefined
    try {
      running = f.chat.send('main-browser')
      await bounded(started.promise)
      await f.unmount()
      await bounded(running)
      assert(launchedCtx?.signal?.aborted)
      gate.resolve()
      await bounded(closeAllBrowserScopes())
      assert.equal(browsers.at(-1)!.closed, 1)
      assert.equal(await alive(launchedCtx), false)
    } finally { gate.resolve(); await running; await closeAllBrowserScopes(); await f.close() }
  })
} finally { await closeAllBrowserScopes(); chromium.launch = originalLaunch }

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
