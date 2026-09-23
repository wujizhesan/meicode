import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/memory/session.ts'
import { RuntimeEventLog } from '../src/runtime/event-log.ts'
import { WorktreeManager } from '../src/worktree/manager.ts'
import { SubAgentStore } from '../src/subagent/store.ts'
import { TeamMail } from '../src/team/mail.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-lazy-state-'))
try {
  const sessionDir = join(root, '.meicode', 'sessions')
  const runtimeDir = join(root, '.meicode', 'runtime-events')
  const worktreeDir = join(root, '.meicode', 'worktrees')
  const subagentDir = join(root, '.meicode', 'subagents')
  const mailDir = join(root, '.meicode', 'team', '_shared', 'mail')

  const sessions = new SessionStore(sessionDir)
  const runtime = new RuntimeEventLog(runtimeDir)
  new WorktreeManager(root)
  const subagents = new SubAgentStore(subagentDir, 'session')
  const mail = new TeamMail(mailDir)

  for (const dir of [sessionDir, runtimeDir, worktreeDir, subagentDir, mailDir]) {
    if (existsSync(dir)) throw new Error(`constructor created state directory: ${dir}`)
  }
  if (sessions.cleanup() !== 0 || sessions.recoverLatest() !== null || sessions.listSessions().length !== 0) {
    throw new Error('missing session directory did not behave as empty')
  }
  if (runtime.read('session').length !== 0 || mail.read('lead').length !== 0) {
    throw new Error('missing runtime or mail directory did not behave as empty')
  }

  sessions.append('session', [{ role: 'user', content: 'hello' }])
  runtime.append({ sessionId: 'session', type: 'run_started' })
  subagents.save({ id: 'agent-1', role: 'general-purpose', type: 'defined', status: 'created', startedAt: Date.now() })
  mail.send('lead', 'worker', 'hello')

  for (const dir of [sessionDir, runtimeDir, subagentDir, mailDir]) {
    if (!existsSync(dir)) throw new Error(`first write did not create state directory: ${dir}`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('lazy_state_dirs_test passed')
