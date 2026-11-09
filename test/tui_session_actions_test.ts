import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { ContextManager } from '../src/context/index.ts'
import { SessionStore } from '../src/memory/index.ts'
import type { MemoryContext } from '../src/memory/index.ts'
import { History } from '../src/session/history.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { SkillManager } from '../src/skill/index.ts'
import { createSessionActions } from '../src/tui/session-actions.ts'

class SummaryProvider implements Provider {
  readonly protocol = 'openai' as const
  fail = false
  requests = 0

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.requests++
    yield this.fail ? { type: 'error', message: '模拟摘要失败' } : { type: 'text', text: '会话摘要' }
  }
}

function largeMessages(): ChatMessage[] {
  return Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(500),
  }))
}

const root = mkdtempSync(join(tmpdir(), 'meicode-session-actions-'))
// 目录守卫放在创建处：若留在 finally 里抛错，会遮蔽真正的断言失败原因
if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('meicode-session-actions-')) {
  throw new Error('测试目录超出临时目录范围')
}

function compactionFixture(provider: Provider, messages = largeMessages()) {
  const history = new History()
  for (const message of messages) history.push(message)
  const manager = new ContextManager({ provider, history, cwd: root, window: 6000, autoMargin: 2000, manualMargin: 2000 })
  const actions = createSessionActions({
    history, contextManager: manager, isStreaming: () => false, resetUi: () => {},
    onSessionChange: (sessionId) => manager.setSessionId(sessionId),
  })
  return { history, manager, actions }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待摘要请求超时')), 2000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

try {
  const store = new SessionStore(join(root, 'sessions'))
  store.append('saved-session', [
    { role: 'user', content: 'saved question' },
    { role: 'assistant', content: 'saved answer' },
  ])
  store.append('deletable-session', [{ role: 'user', content: 'delete me' }])
  const history = new History()
  history.push({ role: 'user', content: 'current' })
  const memory: MemoryContext = { sessionStore: store, sessionId: 'current-session' }
  let streaming = false
  let resetCount = 0
  let runtimeResetCount = 0
  let skillClearCount = 0
  let contextResetCount = 0
  const switchedSessions: string[] = []
  const contextManager = {
    lastSummary: 'summary' as string | null,
    reset: () => { contextResetCount++; contextManager.lastSummary = null },
    compact: async () => {
      contextManager.lastSummary = 'summary'
      return { status: 'compacted', summary: 'summary' }
    },
  } as unknown as ContextManager
  const skillManager = { clear: () => { skillClearCount++ } } as unknown as SkillManager
  const actions = createSessionActions({
    history,
    memory,
    contextManager,
    skillManager,
    isStreaming: () => streaming,
    resetUi: () => { resetCount++ },
    resetRuntime: () => { runtimeResetCount++ },
    onSessionChange: (sessionId) => { switchedSessions.push(sessionId) },
  })

  const resumed = actions.resume('saved-session')
  if (!resumed.includes('2 条消息') || memory.sessionId !== 'saved-session' || history.length !== 2) {
    throw new Error(`session resume mismatch: ${resumed}`)
  }
  if (switchedSessions[0] !== 'saved-session' || skillClearCount !== 1 || runtimeResetCount !== 1) {
    throw new Error('resume 未同步重置会话运行时')
  }
  if (actions.deleteSession('saved-session') !== '不能删除当前会话') throw new Error('current session deletion was allowed')
  if (actions.deleteSession('deletable-session') !== '已删除会话 deletable-session') throw new Error('session deletion failed')
  if (!actions.listSessions().includes('saved-session')) throw new Error('session list omitted recovered session')
  if (await actions.compact() !== '压缩完成：早期对话已摘要') throw new Error('manual compaction result mismatch')

  actions.clearHistory()
  if (history.view().length !== 0 || Number(skillClearCount) !== 2 || Number(runtimeResetCount) !== 2) throw new Error('clear did not reset history and runtime')
  const previousId = memory.sessionId
  if (actions.newSession() !== '已新建会话' || memory.sessionId === previousId) throw new Error('new session did not rotate id')
  if (switchedSessions.at(-1) !== memory.sessionId || Number(skillClearCount) !== 3 || Number(runtimeResetCount) !== 3) {
    throw new Error('new session 未同步迁移运行时')
  }

  streaming = true
  const blockedId = memory.sessionId
  if (actions.newSession() !== '执行中，无法新建会话' || memory.sessionId !== blockedId) {
    throw new Error('streaming session mutation was not blocked')
  }
  if (resetCount !== 3) throw new Error(`unexpected UI reset count: ${resetCount}`)
  if (contextResetCount !== 3) throw new Error(`unexpected context reset count: ${contextResetCount}`)

  const failingProvider = new SummaryProvider()
  failingProvider.fail = true
  const firstFailure = compactionFixture(failingProvider)
  const firstHistory = JSON.stringify(firstFailure.history.view())
  if (await firstFailure.actions.compact() !== '压缩失败: 摘要请求失败: 模拟摘要失败'
    || JSON.stringify(firstFailure.history.view()) !== firstHistory) {
    throw new Error('首次摘要失败未显示错误或改写了历史')
  }
  console.log('  ✓ 首次摘要失败显示实际错误')

  const retryProvider = new SummaryProvider()
  const retry = compactionFixture(retryProvider)
  if (await retry.actions.compact() !== '压缩完成：早期对话已摘要' || retry.history.length !== 7) throw new Error('首次压缩未成功')
  if (await retry.actions.compact() !== '无需压缩（未达窗口上限）' || retryProvider.requests !== 1 || retry.manager.lastSummary !== '会话摘要') {
    throw new Error('旧摘要造成无需压缩时误报成功')
  }
  for (const message of largeMessages()) retry.history.push(message)
  retryProvider.fail = true
  const retryHistory = JSON.stringify(retry.history.view())
  if (await retry.actions.compact() !== '压缩失败: 摘要请求失败: 模拟摘要失败'
    || JSON.stringify(retry.history.view()) !== retryHistory || retry.manager.lastSummary !== '会话摘要') {
    throw new Error('旧摘要造成本次失败误报成功')
  }
  retryProvider.fail = false
  if (await retry.actions.compact() !== '压缩完成：早期对话已摘要' || Number(retry.history.length) !== 7) throw new Error('失败后无法重试压缩')
  console.log('  ✓ 旧摘要不影响本次无需压缩、失败及重试成功的提示')

  const shortProvider = new SummaryProvider()
  const short = compactionFixture(shortProvider, largeMessages().slice(0, 5).map((message) => ({ ...message, content: 'x'.repeat(8000) })))
  if (await short.actions.compact() !== '无需压缩（没有可摘要的早期消息）' || shortProvider.requests !== 0 || short.history.length !== 5) {
    throw new Error('没有早期消息时误报未达阈值')
  }
  console.log('  ✓ 没有可摘要的早期消息时给出对应原因')

  for (const failure of ['empty', 'throw'] as const) {
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(): AsyncGenerator<StreamEvent> {
        if (failure === 'throw') throw '连接中断'
        yield { type: 'text', text: '   ' }
      },
    }
    const fixture = compactionFixture(provider)
    const expected = failure === 'empty' ? '压缩失败: 摘要返回为空' : '压缩失败: 连接中断'
    if (await fixture.actions.compact() !== expected || fixture.history.length !== 40) throw new Error(`${failure}: 未显示真实失败原因`)
    console.log(`  ✓ ${failure}: 摘要失败原因正确显示`)
  }

  const concurrentStarted = deferred()
  const concurrentGate = deferred()
  let concurrentRequests = 0
  const concurrentProvider: Provider = {
    protocol: 'openai',
    async *streamChat(): AsyncGenerator<StreamEvent> {
      concurrentRequests++
      concurrentStarted.resolve()
      await concurrentGate.promise
      yield { type: 'error', message: '共享摘要失败' }
    },
  }
  const concurrent = compactionFixture(concurrentProvider)
  const auto = concurrent.manager.beforeRequest('auto')
  const manualOne = concurrent.actions.compact()
  const manualTwo = concurrent.actions.compact()
  await waitFor(concurrentStarted.promise)
  concurrentGate.resolve()
  const concurrentResults = await Promise.all([manualOne, manualTwo])
  await auto
  if (concurrentRequests !== 1 || !concurrentResults.every((result) => result === '压缩失败: 摘要请求失败: 共享摘要失败')
    || concurrent.manager.breakerOpenState || concurrent.history.length !== 40) {
    throw new Error('自动与手动共享请求时丢失错误或重复累计失败')
  }
  console.log('  ✓ 并发自动与手动压缩共享失败结果')

  for (const change of ['session', 'history'] as const) {
    for (const response of ['success', 'error'] as const) {
      const started = deferred()
      const gate = deferred()
      let hold = false
      const provider: Provider = {
        protocol: 'openai',
        async *streamChat(): AsyncGenerator<StreamEvent> {
          if (hold) {
            started.resolve()
            await gate.promise
            if (response === 'error') {
              yield { type: 'error', message: '过期摘要失败' }
              return
            }
          }
          yield { type: 'text', text: '旧摘要' }
        },
      }
      const fixture = compactionFixture(provider)
      await fixture.actions.compact()
      for (const message of largeMessages()) fixture.history.push(message)
      hold = true
      const pending = fixture.actions.compact()
      await waitFor(started.promise)
      if (change === 'session') {
        fixture.actions.newSession()
        for (const message of largeMessages()) fixture.history.push(message)
      } else fixture.history.replaceRange(0, 1, [{ role: 'user', content: '更新后的背景' }])
      const expected = JSON.stringify(fixture.history.view())
      gate.resolve()
      if (await pending !== '压缩已取消：会话或历史已变化，请重试'
        || JSON.stringify(fixture.history.view()) !== expected || fixture.manager.breakerOpenState) {
        throw new Error(`${change}/${response}: 过期摘要反馈错误或改写新历史`)
      }
      console.log(`  ✓ ${change}/${response}: 过期摘要显示取消`)
    }
  }

  store.append('context-saved-session', largeMessages())
  for (const action of ['clear', 'new', 'resume'] as const) {
    for (const failures of [2, 3]) {
      const history = new History()
      for (const message of largeMessages()) history.push(message)
      const provider = new SummaryProvider()
      const manager = new ContextManager({ provider, history, cwd: root, window: 6000, autoMargin: 2000, sessionId: 'old-session' })
      const memory: MemoryContext = { sessionStore: store, sessionId: 'old-session' }
      let streaming = false
      const actions = createSessionActions({
        history, memory, contextManager: manager,
        isStreaming: () => streaming,
        resetUi: () => {},
        onSessionChange: (sessionId) => manager.setSessionId(sessionId),
      })
      await manager.beforeRequest('auto')
      for (const message of largeMessages()) history.push(message)
      manager.afterRequest(5000, history.length)
      provider.fail = true
      for (let index = 0; index < failures; index++) await manager.beforeRequest('auto')
      if (manager.breakerOpenState !== (failures === 3)) throw new Error('旧会话熔断状态错误')
      const oldBudget = JSON.stringify(manager.snapshot())
      const oldSummary = manager.lastSummary
      streaming = true
      actions.clearHistory()
      if (actions.newSession() !== '执行中，无法新建会话' || actions.resume('context-saved-session') !== '执行中，无法切换会话') {
        throw new Error('执行中仍允许会话切换')
      }
      streaming = false
      if (actions.resume('missing-session') !== '未找到会话: missing-session'
        || JSON.stringify(manager.snapshot()) !== oldBudget || manager.lastSummary !== oldSummary) {
        throw new Error('被拒绝的会话操作重置了当前上下文')
      }
      if (action === 'clear') actions.clearHistory()
      else if (action === 'new') {
        if (actions.newSession() !== '已新建会话') throw new Error('新建会话失败')
      } else if (!actions.resume('context-saved-session').includes('40 条消息')) {
        throw new Error('恢复会话失败')
      }
      const budget = manager.snapshot()
      if (budget.breakerOpen || budget.lastInputTokens !== undefined || manager.lastSummary !== null
        || budget.estimatedTokens !== (action === 'resume' ? 5000 : 0)) {
        throw new Error(`${action}: 重置后仍残留旧摘要或预算状态`)
      }
      if (action !== 'resume') {
        if (await actions.compact() !== '无需压缩（未达窗口上限）') throw new Error('旧摘要造成空历史压缩成功提示')
        for (const message of largeMessages()) history.push(message)
      }
      const requests = provider.requests
      if (failures === 2) {
        await manager.beforeRequest('auto')
        if (provider.requests !== requests + 1 || manager.breakerOpenState) throw new Error(`${action}: 旧失败计数未清零`)
      }
      provider.fail = false
      const beforeRecovery = provider.requests
      await manager.beforeRequest('auto')
      if (provider.requests !== beforeRecovery + 1 || manager.breakerOpenState || history.length !== 7 || manager.lastSummary !== '会话摘要') {
        throw new Error(`${action}: 重置后无法自动摘要`)
      }
      console.log(`  ✓ ${action}: ${failures} 次旧摘要失败后可重新自动压缩`)
    }
  }

  for (const result of ['success', 'error'] as const) {
    const history = new History()
    for (const message of largeMessages()) history.push(message)
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(): AsyncGenerator<StreamEvent> {
        started()
        await gate
        yield result === 'success' ? { type: 'text', text: '旧会话延迟摘要' } : { type: 'error', message: '旧会话延迟失败' }
      },
    }
    const manager = new ContextManager({ provider, history, cwd: root, window: 6000, autoMargin: 2000 })
    const actions = createSessionActions({ history, contextManager: manager, isStreaming: () => false, resetUi: () => {} })
    const pending = manager.beforeRequest('auto')
    await ready
    actions.newSession()
    for (const message of largeMessages()) history.push(message)
    const newHistory = JSON.stringify(history.view())
    release()
    await pending
    if (JSON.stringify(history.view()) !== newHistory || manager.lastSummary !== null || manager.breakerOpenState) {
      throw new Error(`旧摘要 ${result} 回写了新会话`)
    }
    if (result === 'error') {
      await manager.beforeRequest('auto')
      await manager.beforeRequest('auto')
      if (manager.breakerOpenState) throw new Error('旧摘要失败被计入新会话')
      await manager.beforeRequest('auto')
      if (!manager.breakerOpenState) throw new Error('新会话三次失败未熔断')
    }
    console.log(`  ✓ 旧会话延迟 ${result} 不影响新会话`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('tui_session_actions_test passed')
