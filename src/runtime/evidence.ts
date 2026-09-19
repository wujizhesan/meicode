import type { RuntimeEvent } from './events.ts'
import type { ToolEvidence } from '../tools/types.ts'

export interface RuntimeEvidenceSummary {
  files: string[]
  commands: string[]
  artifacts: string[]
  changedFiles: string[]
  tests: { command: string; passed: boolean; output?: string }[]
}

export class RuntimeEvidenceAccumulator {
  private files = new Set<string>()
  private commands = new Set<string>()
  private artifacts = new Set<string>()
  private changedFiles = new Set<string>()
  private tests = new Map<string, { command: string; passed: boolean; output?: string }>()

  add(evidence: ToolEvidence | undefined): void {
    if (!evidence) return
    for (const file of evidence.files ?? []) this.files.add(file)
    for (const command of evidence.commands ?? []) this.commands.add(command)
    for (const artifact of evidence.artifactPaths ?? []) this.artifacts.add(artifact)
    for (const file of evidence.changedFiles ?? []) this.changedFiles.add(file)
    for (const test of evidence.tests ?? []) {
      const key = `${test.command}\u0000${test.passed}\u0000${test.output ?? ''}`
      if (!this.tests.has(key)) this.tests.set(key, test)
    }
  }

  snapshot(): RuntimeEvidenceSummary {
    return {
      files: [...this.files],
      commands: [...this.commands],
      artifacts: [...this.artifacts],
      changedFiles: [...this.changedFiles],
      tests: [...this.tests.values()],
    }
  }
}

export function collectRuntimeEvidence(events: RuntimeEvent[], agentId: string, since = 0): RuntimeEvidenceSummary {
  const accumulator = new RuntimeEvidenceAccumulator()
  for (const event of events) {
    if (event.type !== 'tool_result' || event.agentId !== agentId || event.ts < since) continue
    accumulator.add((event.payload?.evidence ?? {}) as ToolEvidence)
  }
  return accumulator.snapshot()
}
