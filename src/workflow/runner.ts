// Workflow 运行器：phase 状态机（对齐 Zcode phase_started/completed/failed/paused）
// 每个 phase 派 agent 执行 prompt，产物写 artifacts/<phase>.md
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolRegistry, ToolContext } from '../tools/index.ts'
import type { Provider } from '../provider/types.ts'
import type { SubAgentManager } from '../subagent/manager.ts'
import type { TeamManager } from '../team/index.ts'
import type { WorkflowMeta, WorkflowRunRecord } from './types.ts'
import { validateWorkflowMeta } from './validate.ts'

export interface RunWorkflowOptions {
  provider: Provider
  registry: ToolRegistry
  ctx: ToolContext
  subagents: SubAgentManager
  // 团队后端：phase 派 coroutine 成员执行（复用团队能力：死亡感知/契约落盘/等待纪律）
  team?: { manager: TeamManager }
  onProgress?: (msg: string) => void
}

export function artifactsDir(cwd: string): string {
  return join(cwd, '.mewcode', 'workflows', 'artifacts')
}

// 执行 workflow：按 phase 顺序（agents>1 并行），状态机 running→completed/failed
export async function runWorkflow(meta: WorkflowMeta, opts: RunWorkflowOptions): Promise<WorkflowRunRecord> {
  const issues = validateWorkflowMeta(meta)
  if (issues.length > 0) {
    throw new Error(`workflow 校验失败: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`)
  }
  const dir = artifactsDir(opts.ctx.cwd)
  mkdirSync(dir, { recursive: true })
  const record: WorkflowRunRecord = {
    runId: `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    workflow: meta.name,
    status: 'running',
    phases: meta.phases.map((p) => ({ title: p.title, status: 'pending' as const })),
    createdAt: Date.now(),
  }
  const report = (msg: string) => opts.onProgress?.(msg)

  for (let i = 0; i < meta.phases.length; i++) {
    const phase = meta.phases[i]
    const rec = record.phases[i]
    rec.status = 'running'
    rec.startedAt = Date.now()
    report(`[workflow] phase ${i + 1}/${meta.phases.length}: ${phase.title} (running)`)
    try {
      const count = phase.agents ?? 1
      const results = count > 1
        ? await Promise.all(
            Array.from({ length: count }, async (_, k) => {
              const prompt = `${phase.prompt}\n\n（phase ${phase.title} 并行任务 ${k + 1}/${count}）`
              return executePhase(prompt, opts, rec, `${k + 1}`, phase.title)
            }),
          )
        : [await executePhase(phase.prompt, opts, rec, '', phase.title)]
      // 产物：artifacts/<phase>.md（对齐 Zcode artifacts/<phase>.md 约定）
      const artifactPath = join(dir, `${safeName(phase.title)}.md`)
      const body = results.map((r, k) => `## ${phase.title}${count > 1 ? ` #${k + 1}` : ''}\n\n${r}`).join('\n\n')
      writeFileSync(artifactPath, body, 'utf8')
      rec.artifactPath = artifactPath
      rec.status = 'completed'
      rec.finishedAt = Date.now()
      report(`[workflow] phase ${phase.title}: completed → ${artifactPath}`)
    } catch (e) {
      rec.status = 'failed'
      rec.error = (e as Error).message
      rec.finishedAt = Date.now()
      record.status = 'failed'
      record.finishedAt = Date.now()
      report(`[workflow] phase ${phase.title}: failed — ${rec.error}`)
      return record
    }
  }
  record.status = 'completed'
  record.finishedAt = Date.now()
  report(`[workflow] ${meta.name}: completed (${meta.phases.length} phases)`)
  return record
}

async function executePhase(prompt: string, opts: RunWorkflowOptions, rec: { agentId?: string }, suffix: string, phaseTitle: string): Promise<string> {
  // 团队后端：phase 派 coroutine 成员（复用团队能力），否则 fork 子 agent
  if (opts.team) {
    const { manager } = opts.team
    const groupName = `wf-${safeName(opts.ctx.cwd.split(/[\\/]/).pop() ?? 'wf')}`
    const g = manager.loadGroup(groupName) ?? manager.createGroup(groupName, 'lead')
    const memberName = `wf-${safeName(phaseTitle)}${suffix ? `-${suffix}` : ''}`
    if (!manager.getMember(memberName)) {
      await manager.spawnMember(g, memberName, 'general-purpose')
    }
    const task = manager.addTask(g.name, prompt, memberName)
    rec.agentId = memberName
    const res = await manager.runTask(g, task, memberName)
    return res.includes('仍在执行中') ? `(成员后台执行中, 用 /team tasks ${groupName} 查看)` : res
  }
  const { syncResult } = await opts.subagents.spawn(
    { type: 'fork', prompt, parentHistory: [] },
    { provider: opts.provider, registry: opts.registry, ctx: opts.ctx },
  )
  rec.agentId = `sub-${suffix}`
  return syncResult ?? '(无输出)'
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// 校验：文件是否存在可加载（供 /workflow validate 用）
export async function validateWorkflowFile(load: () => Promise<WorkflowMeta>): Promise<string> {
  try {
    const meta = await load()
    const issues = validateWorkflowMeta(meta)
    return issues.length === 0 ? `校验通过: ${meta.name} (${meta.phases.length} phases)` : `校验失败:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`
  } catch (e) {
    return `校验失败: ${(e as Error).message}`
  }
}
