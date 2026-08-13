// Workflow 运行持久化（对齐 Zcode workflow_run SQLite → MeiCode JSON 文件）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowRunRecord } from './types.ts'

export function runsDir(cwd: string): string {
  return join(cwd, '.mewcode', 'workflows', 'runs')
}

export function saveRun(cwd: string, record: WorkflowRunRecord): void {
  const dir = runsDir(cwd)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record, null, 2), 'utf8')
}

export function loadRun(cwd: string, runId: string): WorkflowRunRecord | null {
  const file = join(runsDir(cwd), `${runId}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as WorkflowRunRecord
  } catch {
    return null
  }
}

export function listRuns(cwd: string, limit = 20): WorkflowRunRecord[] {
  const dir = runsDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorkflowRunRecord
      } catch {
        return null
      }
    })
    .filter((r): r is WorkflowRunRecord => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}
