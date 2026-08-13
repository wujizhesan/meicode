// Workflow meta 校验（对齐 Zcode /workflow validate：只查 meta 不派 agent）
import type { WorkflowMeta } from './types.ts'

export interface ValidationIssue {
  path: string
  message: string
}

export function validateWorkflowMeta(meta: WorkflowMeta): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!meta || typeof meta !== 'object') {
    return [{ path: 'meta', message: 'meta 缺失或不是对象' }]
  }
  if (!meta.name || typeof meta.name !== 'string' || !meta.name.trim()) {
    issues.push({ path: 'name', message: 'name 必填（字符串）' })
  }
  if (meta.description !== undefined && typeof meta.description !== 'string') {
    issues.push({ path: 'description', message: 'description 必须是字符串' })
  }
  if (!Array.isArray(meta.phases) || meta.phases.length === 0) {
    issues.push({ path: 'phases', message: 'phases 必填且至少一个 phase' })
    return issues
  }
  const titles = new Set<string>()
  meta.phases.forEach((p, i) => {
    const path = `phases[${i}]`
    if (!p || typeof p !== 'object') {
      issues.push({ path, message: 'phase 必须是对象' })
      return
    }
    if (!p.title || typeof p.title !== 'string' || !p.title.trim()) {
      issues.push({ path: `${path}.title`, message: 'title 必填' })
    } else if (titles.has(p.title)) {
      issues.push({ path: `${path}.title`, message: `title 重复: ${p.title}` })
    } else {
      titles.add(p.title)
    }
    if (!p.prompt || typeof p.prompt !== 'string' || !p.prompt.trim()) {
      issues.push({ path: `${path}.prompt`, message: 'prompt 必填（agent 任务描述）' })
    }
    if (p.agents !== undefined && (!Number.isInteger(p.agents) || p.agents < 1 || p.agents > 8)) {
      issues.push({ path: `${path}.agents`, message: 'agents 必须是 1-8 的整数' })
    }
  })
  return issues
}
