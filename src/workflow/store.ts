// Workflow 运行持久化（对齐 Zcode workflow_run SQLite → MeiCode JSON 文件）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowRunRecord } from './types.ts'

interface CachedWorkflowRun {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  record: WorkflowRunRecord | null
}

const workflowRunCache = new Map<string, CachedWorkflowRun>()

function cloneWorkflowRun(record: WorkflowRunRecord): WorkflowRunRecord {
  return { ...record, phases: record.phases.map((phase) => ({ ...phase })) }
}

function readCachedRun(file: string): WorkflowRunRecord | null {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(file)
  } catch {
    workflowRunCache.delete(file)
    return null
  }
  const cached = workflowRunCache.get(file)
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) {
    return cached.record
  }
  let record: WorkflowRunRecord | null = null
  try {
    record = JSON.parse(readFileSync(file, 'utf8')) as WorkflowRunRecord
  } catch {
  }
  workflowRunCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, record })
  return record
}

export function runsDir(cwd: string): string {
  return join(cwd, '.mewcode', 'workflows', 'runs')
}

export function saveRun(cwd: string, record: WorkflowRunRecord): void {
  const dir = runsDir(cwd)
  const file = join(dir, `${record.runId}.json`)
  const content = JSON.stringify(record, null, 2)
  try {
    writeFileSync(file, content, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  workflowRunCache.delete(file)
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
      return readCachedRun(join(dir, f))
    })
    .filter((r): r is WorkflowRunRecord => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(cloneWorkflowRun)
}
