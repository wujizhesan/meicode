import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionStore } from '../src/memory/index.ts'
import {
  bootstrapSessionRuntime,
  resolveSessionDirectory,
} from '../src/runtime/session-bootstrap.ts'
import { projectStatePath, userStatePath } from '../src/state-paths.ts'

const root = join(import.meta.dirname, 'fixtures_session_bootstrap')
const paths = {
  sessions: join(root, 'state', 'sessions'),
  runtimeEvents: join(root, 'state', 'runtime-events'),
  userMemory: join(root, 'user-memory'),
  projectMemory: join(root, 'project-memory'),
}

async function main(): Promise<void> {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'instructions.md'), '启动边界指令', 'utf8')
  const store = new SessionStore(paths.sessions)
  store.append('saved-session', [
    { role: 'user', content: '已保存问题' },
    { role: 'assistant', content: '已保存回答' },
  ])

  const resumed = await bootstrapSessionRuntime({ cwd: root, resume: 'saved-session', paths })
  if (resumed.recovered?.id !== 'saved-session' || resumed.recovered.count !== 2) {
    throw new Error(`显式恢复结果错误: ${JSON.stringify(resumed.recovered)}`)
  }
  if (resumed.history.length !== 2 || resumed.sessionId !== 'saved-session') throw new Error('历史未恢复到运行时')
  if (!resumed.memory.instructions?.includes('启动边界指令')) throw new Error('项目指令未载入运行时')
  if (resumed.memory.noteUserDir !== paths.userMemory || resumed.memory.noteProjectDir !== paths.projectMemory) {
    throw new Error('记忆目录未按启动路径注入')
  }

  const fresh = await bootstrapSessionRuntime({ cwd: root, recoverLatest: false, paths })
  if (fresh.recovered || fresh.history.length !== 0 || fresh.sessionId === 'saved-session') {
    throw new Error('禁用自动恢复时仍复用了旧会话')
  }

  let missingMessage = ''
  try {
    await bootstrapSessionRuntime({ cwd: root, resume: 'missing-session', paths })
  } catch (error) {
    missingMessage = (error as Error).message
  }
  if (missingMessage !== '未找到会话 missing-session') throw new Error(`缺失会话错误不明确: ${missingMessage}`)

  if (resolveSessionDirectory(root, 'linux') !== projectStatePath(root, 'sessions')) {
    throw new Error('普通工作目录未使用项目会话目录')
  }
  if (resolveSessionDirectory('C:\\Windows\\System32', 'win32') !== userStatePath('sessions')) {
    throw new Error('Windows 系统目录未回退到用户会话目录')
  }

  rmSync(root, { recursive: true, force: true })
  console.log('session_bootstrap_test passed')
}

main().catch((error) => {
  rmSync(root, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
