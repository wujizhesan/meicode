import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_STATE_DIR_NAME, STATE_DIR_NAME, resolveStateRoot } from '../src/state-paths.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-state-paths-'))
try {
  const current = join(root, STATE_DIR_NAME)
  const legacy = join(root, LEGACY_STATE_DIR_NAME)

  if (resolveStateRoot(root) !== current) throw new Error('new workspace did not choose .meicode')
  if (existsSync(current)) throw new Error('path resolution eagerly created the state directory')

  mkdirSync(legacy)
  if (resolveStateRoot(root) !== legacy) throw new Error('legacy .mewcode directory was not preserved')

  mkdirSync(current)
  if (resolveStateRoot(root) !== current) throw new Error('current .meicode directory did not take precedence')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('state_paths_test passed')
