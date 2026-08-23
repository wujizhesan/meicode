import type { RuntimeEvent } from './events.ts'
import type { ToolEvidence } from '../tools/types.ts'

export interface RuntimeEvidenceSummary {
  files: string[]
  commands: string[]
  artifacts: string[]
  changedFiles: string[]
  tests: { command: string; passed: boolean; output?: string }[]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function collectRuntimeEvidence(events: RuntimeEvent[], agentId: string, since = 0): RuntimeEvidenceSummary {
  const files: string[] = []
  const commands: string[] = []
  const artifacts: string[] = []
  const changedFiles: string[] = []
  const tests: { command: string; passed: boolean; output?: string }[] = []
  for (const event of events) {
    if (event.type !== 'tool_result' || event.agentId !== agentId || event.ts < since) continue
    const evidence = (event.payload?.evidence ?? {}) as ToolEvidence
    files.push(...(evidence.files ?? []))
    commands.push(...(evidence.commands ?? []))
    artifacts.push(...(evidence.artifactPaths ?? []))
    changedFiles.push(...(evidence.changedFiles ?? []))
    tests.push(...(evidence.tests ?? []))
  }
  const testKeys = new Set<string>()
  const uniqueTests = tests.filter((test) => {
    const key = `${test.command}\u0000${test.passed}\u0000${test.output ?? ''}`
    if (testKeys.has(key)) return false
    testKeys.add(key)
    return true
  })
  return { files: unique(files), commands: unique(commands), artifacts: unique(artifacts), changedFiles: unique(changedFiles), tests: uniqueTests }
}
