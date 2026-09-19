import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLogger, initLogger, log } from '../src/log.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-log-'))
try {
  const first = join(root, 'first')
  initLogger(first)
  log('info', 'first-line')
  log('error', 'second-line')

  const second = join(root, 'second')
  initLogger(second)
  log('warn', 'other-file')
  closeLogger()

  const firstLog = readFileSync(join(first, '.mewcode', 'meicode.log'), 'utf8')
  const secondLog = readFileSync(join(second, '.mewcode', 'meicode.log'), 'utf8')
  if (!firstLog.includes('first-line') || !firstLog.includes('second-line')) throw new Error('reused descriptor lost log lines')
  if (firstLog.includes('other-file') || !secondLog.includes('other-file')) throw new Error('logger reinitialization used stale descriptor')
} finally {
  closeLogger()
  rmSync(root, { recursive: true, force: true })
}

console.log('log_test passed')
