import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { guardPath } from '../src/tools/types.ts'

const root = join(process.cwd(), '.tmp-sandbox-root')
const outside = join(process.cwd(), '.tmp-sandbox-outside')
rmSync(root, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
mkdirSync(outside, { recursive: true })

try {
  symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  if (guardPath({ cwd: root, rootLock: root }, join(root, 'link', 'escaped.txt')) === null) throw new Error('符号链接越界未拦')
  console.log('sandbox_test passed')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
