import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finalizeSend } from '../src/tui/send-finalizer.ts'
import { createSessionPersistenceCursor, SessionStore } from '../src/memory/index.ts'
import { History } from '../src/session/history.ts'
import { SkillManager } from '../src/skill/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import type { UIMessage } from '../src/tui/types.ts'

const root = join(import.meta.dirname, 'fixtures_send_finalizer')
const builtin = join(root, 'builtin')
const user = join(root, 'user')
const project = join(root, 'project')
rmSync(root, { recursive: true, force: true })
for (const directory of [builtin, user, project]) mkdirSync(directory, { recursive: true })

const provider: Provider = {
  protocol: 'openai',
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'done' }
  },
}

async function main(): Promise<void> {
  const history = new History()
  const store = new SessionStore(join(root, 'sessions'))
  const cursor = createSessionPersistenceCursor(history)
  history.push({ role: 'user', content: '问题' })
  const startLength = history.length
  history.push({ role: 'assistant', content: '回答' })
  const hookMessages: string[] = []

  await finalizeSend({
    provider,
    history,
    registry: new ToolRegistry(),
    ctx: { cwd: root },
    memory: { sessionStore: store, sessionId: 'finalizer-basic' },
    hooks: {
      async fire(_event, context): Promise<void> {
        hookMessages.push(context.message?.content ?? '')
      },
    },
    startLength,
    persistenceCursor: cursor,
    appendMessage: () => {},
    cwd: root,
  })

  if (hookMessages.join(',') !== '回答') throw new Error(`message Hook 收到错误消息: ${hookMessages.join(',')}`)
  const recovered = store.recoverById('finalizer-basic')
  if (recovered?.messages.length !== 2 || recovered.messages[0].content !== '问题') {
    throw new Error('发送收尾未完整持久化本轮消息')
  }

  writeFileSync(join(project, 'review.md'), `---
name: review
description: 独立审查
tools: [read_file]
mode: isolated
---
检查代码
`, 'utf8')
  const skillManager = new SkillManager({ builtin, user, project })
  skillManager.loadAll()
  skillManager.activate('review')
  const isolatedHistory = new History()
  const isolatedCursor = createSessionPersistenceCursor(isolatedHistory)
  isolatedHistory.push({ role: 'assistant', content: '主流程完成' })
  const messages: UIMessage[] = []
  let hookRan = false

  await finalizeSend({
    provider,
    history: isolatedHistory,
    registry: new ToolRegistry(),
    ctx: { cwd: root },
    memory: { sessionStore: store, sessionId: 'finalizer-failure' },
    skillManager,
    hooks: {
      async fire(): Promise<void> {
        hookRan = true
        throw new Error('hook failed')
      },
    },
    startLength: 0,
    persistenceCursor: isolatedCursor,
    appendMessage: (message) => messages.push(message),
    cwd: root,
  }, {
    runIsolatedSkill: async () => {
      throw new Error('isolated failed')
    },
  })

  const failure = isolatedHistory.view()[1]?.content ?? ''
  if (!failure.includes('执行失败：isolated failed')) throw new Error(`独立 Skill 失败未回流: ${failure}`)
  if (!hookRan) throw new Error('独立 Skill 失败阻断了 message Hook')
  if (skillManager.lastActivated !== null) throw new Error('独立 Skill 激活标记未清理')
  if (!messages[0]?.text.includes('isolated failed')) throw new Error('独立 Skill 失败未写入 UI')
  const failureSession = store.recoverById('finalizer-failure')
  if (failureSession?.messages.length !== 2) throw new Error('Hook 失败阻断了会话持久化')

  const conflictStore = new SessionStore(join(root, 'sessions'))
  conflictStore.replace('finalizer-conflict', [{ role: 'user', content: 'original' }])
  const externalStore = new SessionStore(join(root, 'sessions'))
  externalStore.recoverById('finalizer-conflict')
  externalStore.append('finalizer-conflict', [{ role: 'assistant', content: 'external' }])
  const conflictHistory = new History()
  conflictHistory.push({ role: 'user', content: 'original' })
  const conflictCursor = createSessionPersistenceCursor(conflictHistory)
  conflictHistory.push({ role: 'assistant', content: 'local' })
  const conflictMessages: UIMessage[] = []
  const conflictTransitions: string[] = []
  const conflictMemory = { sessionStore: conflictStore, sessionId: 'finalizer-conflict' }
  const conflictCtx = { cwd: root, sessionId: 'finalizer-conflict' }
  await finalizeSend({
    provider,
    history: conflictHistory,
    registry: new ToolRegistry(),
    ctx: conflictCtx,
    memory: conflictMemory,
    startLength: 1,
    persistenceCursor: conflictCursor,
    appendMessage: (message) => conflictMessages.push(message),
    onSessionChange: (sessionId) => { conflictTransitions.push(sessionId) },
    cwd: root,
  })
  const conflictCopy = conflictStore.listSessions(20).find((session) => session.id.startsWith('finalizer-conflict-conflict-'))
  if (!conflictCopy || !conflictMessages.some((message) => message.text.includes(conflictCopy.id))) {
    throw new Error('会话冲突未显示冲突副本提示')
  }
  const copied = conflictStore.recoverById(conflictCopy.id)
  const original = conflictStore.recoverById('finalizer-conflict')
  if (copied?.messages.at(-1)?.content !== 'local' || original?.messages.at(-1)?.content !== 'external') {
    throw new Error('会话冲突副本未保全本地内容或覆盖了原会话')
  }
  if (conflictMemory.sessionId !== conflictCopy.id || conflictCtx.sessionId !== conflictCopy.id || !conflictMessages.some((message) => message.text.includes('自动切换'))) {
    throw new Error('会话冲突后未自动切换到保全副本')
  }
  if (conflictTransitions.length !== 1 || conflictTransitions[0] !== conflictCopy.id) throw new Error('冲突副本未迁移运行时会话')
  const copyCount = conflictStore.listSessions(30).filter((session) => session.id.startsWith('finalizer-conflict-conflict-')).length
  const followUpStart = conflictHistory.length
  conflictHistory.push({ role: 'user', content: 'continue-on-copy' })
  await finalizeSend({
    provider,
    history: conflictHistory,
    registry: new ToolRegistry(),
    ctx: conflictCtx,
    memory: conflictMemory,
    startLength: followUpStart,
    persistenceCursor: conflictCursor,
    appendMessage: (message) => conflictMessages.push(message),
    onSessionChange: (sessionId) => { conflictTransitions.push(sessionId) },
    cwd: root,
  })
  const afterFollowUp = conflictStore.recoverById(conflictCopy.id)
  if (conflictStore.listSessions(30).filter((session) => session.id.startsWith('finalizer-conflict-conflict-')).length !== copyCount || afterFollowUp?.messages.at(-1)?.content !== 'continue-on-copy') {
    throw new Error('切换冲突副本后仍重复创建副本或未继续持久化')
  }
  if (conflictTransitions.length !== 1) throw new Error('正常续写重复触发运行时会话迁移')

  const deletedStore = new SessionStore(join(root, 'sessions'))
  deletedStore.replace('finalizer-deleted', [{ role: 'user', content: 'before-delete' }])
  new SessionStore(join(root, 'sessions')).removeById('finalizer-deleted')
  const deletedHistory = new History()
  deletedHistory.push({ role: 'user', content: 'before-delete' })
  const deletedCursor = createSessionPersistenceCursor(deletedHistory)
  deletedHistory.push({ role: 'assistant', content: 'after-delete' })
  const deletedMessages: UIMessage[] = []
  const deletedMemory = { sessionStore: deletedStore, sessionId: 'finalizer-deleted' }
  await finalizeSend({
    provider,
    history: deletedHistory,
    registry: new ToolRegistry(),
    ctx: { cwd: root },
    memory: deletedMemory,
    startLength: 1,
    persistenceCursor: deletedCursor,
    appendMessage: (message) => deletedMessages.push(message),
    cwd: root,
  })
  const deletedCopy = deletedStore.listSessions(30).find((session) => session.id.startsWith('finalizer-deleted-conflict-'))
  if (!deletedCopy || deletedStore.recoverById('finalizer-deleted') || !deletedMessages.some((message) => message.text.includes(deletedCopy.id))) {
    throw new Error('外部删除会话未转存为冲突副本')
  }
  if (deletedMemory.sessionId !== deletedCopy.id) throw new Error('外部删除冲突后未切换到保全副本')

  rmSync(root, { recursive: true, force: true })
  console.log('send_finalizer_test passed')
}

main().catch((error) => {
  rmSync(root, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
