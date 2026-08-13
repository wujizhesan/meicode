// Workflow 文件加载：.mewcode/workflows/<name>.workflow.js（项目级）+ ~/.mewcode/workflows/（用户级）
// DSL: export const meta = { name, description, phases }
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkflowMeta } from './types.ts'

export function projectWorkflowsDir(cwd: string): string {
  return join(resolve(cwd), '.mewcode', 'workflows')
}

export function userWorkflowsDir(): string {
  return join(homedir(), '.mewcode', 'workflows')
}

export function ensureWorkflowDirs(cwd: string): { project: string; user: string } {
  const project = projectWorkflowsDir(cwd)
  const user = userWorkflowsDir()
  mkdirSync(project, { recursive: true })
  mkdirSync(user, { recursive: true })
  return { project, user }
}

export function workflowPath(cwd: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const project = join(projectWorkflowsDir(cwd), `${safe}.workflow.js`)
  if (existsSync(project)) return project
  const user = join(userWorkflowsDir(), `${safe}.workflow.js`)
  return existsSync(user) ? user : project // 默认落项目级
}

export function listWorkflows(cwd: string): string[] {
  const dirs = [projectWorkflowsDir(cwd), userWorkflowsDir()]
  const names = new Set<string>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.workflow.js')) names.add(f.replace(/\.workflow\.js$/, ''))
    }
  }
  return [...names].sort()
}

// 动态加载 .workflow.js（ESM import，返回 export.meta）
export async function loadWorkflow(cwd: string, name: string): Promise<WorkflowMeta> {
  const path = workflowPath(cwd, name)
  if (!existsSync(path)) throw new Error(`workflow 不存在: ${name}（${path}）`)
  const mod = (await import(pathToFileURL(path).href)) as { meta?: WorkflowMeta }
  if (!mod.meta || typeof mod.meta !== 'object') {
    throw new Error(`${path} 缺少 export const meta（DSL: export const meta = { name, description, phases }）`)
  }
  return mod.meta
}

export const WORKFLOW_TEMPLATE = `// MeiCode Workflow DSL（对齐 Zcode：export const meta = { name, description, phases }）
export const meta = {
  name: 'NAME',
  description: 'DESC',
  phases: [
    { title: 'phase1', prompt: '第一个阶段的任务描述（agent 执行）' },
    // agents > 1 时该 phase 并行派多个 agent
    // { title: 'phase2', prompt: '第二个阶段的任务描述', agents: 2 },
  ],
}
`
