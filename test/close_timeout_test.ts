import { settleCloseTask } from '../src/runtime/close-timeout.ts'

const warnings: string[] = []
const warn = (message: string): void => { warnings.push(message) }

const closed = await settleCloseTask('fast', async () => {}, 20, warn)
if (closed !== 'closed' || warnings.length !== 0) throw new Error('successful close task changed')

const failed = await settleCloseTask('broken', async () => { throw new Error('offline') }, 20, warn)
if (failed !== 'failed' || !warnings.some((message) => message.includes('broken') && message.includes('offline'))) {
  throw new Error(`failed close task was not reported: ${warnings.join(',')}`)
}

const startedAt = Date.now()
const timedOut = await settleCloseTask('stuck', () => new Promise(() => {}), 15, warn)
const elapsed = Date.now() - startedAt
if (timedOut !== 'timed_out' || elapsed > 500) throw new Error(`close timeout did not release promptly: ${timedOut}/${elapsed}`)
if (!warnings.some((message) => message.includes('stuck') && message.includes('15ms'))) {
  throw new Error(`close timeout warning missing: ${warnings.join(',')}`)
}

console.log('close_timeout_test passed')
