import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextManager } from '../src/context/index.ts'
import { SessionStore } from '../src/memory/index.ts'
import type { MemoryContext } from '../src/memory/index.ts'
import { History } from '../src/session/history.ts'
import type { SkillManager } from '../src/skill/index.ts'
import { createSessionActions } from '../src/tui/session-actions.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-session-actions-'))
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
  const switchedSessions: string[] = []
  const contextManager = {
    lastSummary: 'summary',
    beforeRequest: async () => {},
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
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('tui_session_actions_test passed')
