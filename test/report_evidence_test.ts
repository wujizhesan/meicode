import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { collectRuntimeEvidence, RuntimeEventLog, createRuntimeId } from '../src/runtime/index.ts'

const root = join(import.meta.dirname, 'fixtures_report_evidence')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const log = new RuntimeEventLog(root)
const sessionId = createRuntimeId('session')
const agentId = createRuntimeId('agent')
log.append({
  sessionId,
  agentId,
  type: 'tool_result',
  payload: {
    evidence: {
      files: ['a.ts'],
      commands: ['npm test'],
      changedFiles: ['a.ts'],
      artifactPaths: ['.mewcode/artifacts/a.json'],
      tests: [{ command: 'npm test', passed: true }],
    },
  },
})
log.append({
  sessionId,
  agentId,
  type: 'tool_result',
  payload: { evidence: { files: ['a.ts'], commands: ['npm test'], tests: [{ command: 'npm test', passed: true }] } },
})
log.append({ sessionId, agentId: createRuntimeId('agent'), type: 'tool_result', payload: { evidence: { files: ['other.ts'] } } })

const evidence = collectRuntimeEvidence(log.read(sessionId), agentId)
if (evidence.files.length !== 1 || evidence.files[0] !== 'a.ts') throw new Error('报告文件证据未聚合')
if (evidence.commands.length !== 1 || evidence.changedFiles.length !== 1 || evidence.artifacts.length !== 1) throw new Error('报告路径证据未聚合')
if (evidence.tests.length !== 1 || !evidence.tests[0].passed) throw new Error('报告测试证据未去重')

console.log('report_evidence_test passed')
