import { runStreamingLifecycle, streamingFailureMessage } from '../src/tui/send-lifecycle.ts'

let running = false
const transitions: string[] = []
let failure = ''

await runStreamingLifecycle({
  isRunning: () => running,
  start: () => {
    running = true
    transitions.push('start')
  },
  fail: (error) => {
    failure = streamingFailureMessage(error)
    transitions.push('fail')
  },
  finish: async () => {
    await Promise.resolve()
    running = false
    transitions.push('finish')
  },
}, async () => {
  transitions.push('task')
  throw new Error('prompt build failed')
})

if (running) throw new Error('streaming state leaked after failure')
if (failure !== '执行失败：prompt build failed') throw new Error(`failure message changed: ${failure}`)
if (transitions.join(',') !== 'start,task,fail,finish') throw new Error(`lifecycle order changed: ${transitions.join(',')}`)

running = true
let blockedTaskRan = false
await runStreamingLifecycle({
  isRunning: () => running,
  start: () => { throw new Error('already-running send restarted') },
  fail: () => {},
  finish: () => {},
}, async () => {
  blockedTaskRan = true
})
if (blockedTaskRan) throw new Error('concurrent send was not ignored')

running = false
const startFailure: string[] = []
await runStreamingLifecycle({
  isRunning: () => running,
  start: () => {
    running = true
    startFailure.push('start')
    throw new Error('state update failed')
  },
  fail: () => startFailure.push('fail'),
  finish: () => {
    running = false
    startFailure.push('finish')
  },
}, async () => {
  startFailure.push('task')
})
if (running || startFailure.join(',') !== 'start,fail,finish') {
  throw new Error(`start failure leaked lifecycle state: ${startFailure.join(',')}`)
}

if (streamingFailureMessage('offline') !== '执行失败：offline') throw new Error('non-Error failure formatting changed')

console.log('send_lifecycle_test passed')
