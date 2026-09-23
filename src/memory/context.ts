import type { RuntimeEventLog } from '../runtime/event-log.ts'
import type { SessionStore } from './session.ts'
import { buildNotesIndex } from './notes.ts'

export interface MemoryContext {
  sessionStore?: SessionStore
  sessionId?: string
  runtimeEvents?: RuntimeEventLog
  instructions?: string
  noteUserDir?: string
  noteProjectDir?: string
}

export function buildMemoryTail(memory?: MemoryContext): string {
  if (!memory?.instructions && !memory?.noteUserDir && !memory?.noteProjectDir) return ''
  const notes = memory.noteUserDir && memory.noteProjectDir
    ? buildNotesIndex(memory.noteUserDir, memory.noteProjectDir)
    : '（无）'
  return `\n\n## 项目指令\n${memory.instructions ?? '（无）'}\n\n## 记忆索引\n${notes}`
}
