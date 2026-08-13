import { MODULES } from './modules.ts'

export function buildSystemPrompt(_mode: 'plan' | 'full'): string {
  return [...MODULES]
    .sort((a, b) => a.priority - b.priority)
    .map((m) => m.content)
    .join('\n\n')
}

// P3 兼容签名
export function buildPrompt(mode: 'plan' | 'full', planContext?: string): string {
  const base = buildSystemPrompt(mode)
  if (mode === 'plan') return base
  if (planContext) return `${base}\n\n你已制定的计划：\n${planContext}\n\n请按计划执行。`
  return base
}

export * from './modules.ts'
export * from './rules.ts'
export * from './environment.ts'
export * from './injection.ts'
