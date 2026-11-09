import { loadInstructions, newSessionId, SessionStore } from '../memory/index.ts'
import type { MemoryContext } from '../memory/index.ts'
import { History } from '../session/history.ts'
import { projectStatePath, userStatePath } from '../state-paths.ts'
import { RuntimeEventLog } from './event-log.ts'

export interface SessionRuntimePaths {
  sessions: string
  runtimeEvents: string
  userMemory: string
  projectMemory: string
}

export interface SessionBootstrapOptions {
  cwd: string
  resume?: string
  recoverLatest?: boolean
  retentionDays?: number
  paths?: Partial<SessionRuntimePaths>
}

export interface SessionBootstrapResult {
  history: History
  memory: MemoryContext
  sessionId: string
  runtimeEvents: RuntimeEventLog
  removed: number
  recovered: { id: string; count: number } | null
}

export function resolveSessionDirectory(cwd: string, platform = process.platform): string {
  if (platform === 'win32' && /^[A-Za-z]:\\Windows\\(?:System32|SysWOW64)(?:\\|$)/i.test(cwd)) {
    return userStatePath('sessions')
  }
  return projectStatePath(cwd, 'sessions')
}

export function resolveSessionRuntimePaths(cwd: string): SessionRuntimePaths {
  return {
    sessions: resolveSessionDirectory(cwd),
    runtimeEvents: projectStatePath(cwd, 'runtime-events'),
    userMemory: userStatePath('memory'),
    projectMemory: projectStatePath(cwd, 'memory'),
  }
}

export async function bootstrapSessionRuntime(options: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
  const paths = { ...resolveSessionRuntimePaths(options.cwd), ...options.paths }
  const sessionStore = new SessionStore(paths.sessions)
  const removed = sessionStore.cleanup(options.retentionDays ?? 30)
  const recoveredSession = options.resume
    ? sessionStore.recoverById(options.resume)
    : options.recoverLatest ? sessionStore.recoverLatest() : null
  if (options.resume && !recoveredSession) throw new Error(`未找到会话 ${options.resume}`)

  const history = new History()
  if (recoveredSession) {
    for (const message of recoveredSession.messages) history.push(message)
  }
  const sessionId = recoveredSession?.id ?? newSessionId()
  const runtimeEvents = new RuntimeEventLog(paths.runtimeEvents)
  const instructions = await loadInstructions(options.cwd)
  const memory: MemoryContext = {
    sessionStore,
    sessionId,
    runtimeEvents,
    instructions: instructions || undefined,
    noteUserDir: paths.userMemory,
    noteProjectDir: paths.projectMemory,
  }

  return {
    history,
    memory,
    sessionId,
    runtimeEvents,
    removed,
    recovered: recoveredSession ? { id: recoveredSession.id, count: recoveredSession.messages.length } : null,
  }
}
