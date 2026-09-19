import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeIntelTool } from '../src/tools/code_intel_lazy.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-code-intel-'))
try {
  const file = join(root, 'sample.ts')
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n', 'utf8')
  writeFileSync(file, "export const value: string = 'ok'\n", 'utf8')
  const valid = await codeIntelTool.execute({ action: 'diagnostics', file }, { cwd: root })
  if (!valid.success || !valid.output.includes('无诊断错误')) throw new Error(`initial diagnostics failed: ${JSON.stringify(valid)}`)

  writeFileSync(file, 'export const value: string = 1\n', 'utf8')
  const changed = await codeIntelTool.execute({ action: 'diagnostics', file }, { cwd: root })
  if (!changed.success || !changed.output.includes('[error]')) throw new Error(`cached service missed file change: ${JSON.stringify(changed)}`)

  const addedFile = join(root, 'added.ts')
  writeFileSync(addedFile, "import { value } from './sample'\nexport const result: number = value\n", 'utf8')
  const added = await codeIntelTool.execute({ action: 'diagnostics', file: addedFile }, { cwd: root })
  if (!added.success || added.output.includes('Cannot find module')) throw new Error(`cached service missed added file: ${JSON.stringify(added)}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('code_intel_test passed')
