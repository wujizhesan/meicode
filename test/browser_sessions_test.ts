import assert from 'node:assert/strict'
import type { Browser } from 'playwright-core'
import { BrowserSessionPool } from '../src/tools/browser_sessions.ts'
import type { ToolContext } from '../src/tools/types.ts'

const closed: string[] = []
function fakeBrowser(id: string): Browser {
  let disconnected: (() => void) | undefined
  return {
    newPage: async () => ({ id }),
    close: async () => {
      closed.push(id)
      disconnected?.()
    },
    on: (_event: string, listener: () => void) => { disconnected = listener },
  } as unknown as Browser
}

const first: ToolContext = { cwd: process.cwd(), sessionId: 'session-1', agentId: 'agent-a' }
const second: ToolContext = { ...first, agentId: 'agent-b' }
const nextSession: ToolContext = { ...first, sessionId: 'session-2' }
let launches = 0
const pool = new BrowserSessionPool(async () => {
  const id = String(++launches)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return fakeBrowser(id)
})

const started = await Promise.all([
  pool.launch(first, true),
  pool.launch(first, true),
  pool.launch(second, true),
  pool.launch(nextSession, true),
])
assert.deepEqual(started, [true, false, true, true])
assert.equal(launches, 3)
assert.notEqual(pool.get(first)?.page, pool.get(second)?.page)
assert.notEqual(pool.get(first)?.page, pool.get(nextSession)?.page)

assert.equal(await pool.close(first), true)
assert.equal(pool.get(first), null)
assert.notEqual(pool.get(second), null)
assert.notEqual(pool.get(nextSession), null)
assert.equal(closed.length, 1)

await pool.closeAll()
assert.equal(pool.get(second), null)
assert.equal(pool.get(nextSession), null)
assert.equal(closed.length, 3)

let finishLaunch: ((browser: Browser) => void) | undefined
const pendingPool = new BrowserSessionPool(() => new Promise((resolve) => { finishLaunch = resolve }))
const launching = pendingPool.launch(first, true)
const closing = pendingPool.close(first)
finishLaunch?.(fakeBrowser('pending'))
assert.equal(await launching, true)
assert.equal(await closing, true)
assert.equal(pendingPool.get(first), null)
assert.ok(closed.includes('pending'))

let fail = true
const retryPool = new BrowserSessionPool(async () => {
  if (fail) {
    fail = false
    throw new Error('launch failed')
  }
  return fakeBrowser('retry')
})
await assert.rejects(retryPool.launch(first, true), /launch failed/)
assert.equal(await retryPool.launch(first, true), true)
await retryPool.closeAll()

let finishClose: (() => void) | undefined
const slowBrowser = {
  newPage: async () => ({}),
  close: () => new Promise<void>((resolve) => { finishClose = resolve }),
  on: () => {},
} as unknown as Browser
const slowPool = new BrowserSessionPool(async () => slowBrowser)
await slowPool.launch(first, true)
const closingScope = slowPool.close(first)
const closingAll = slowPool.closeAll()
let allClosed = false
void closingAll.then(() => { allClosed = true })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(allClosed, false)
finishClose?.()
await Promise.all([closingScope, closingAll])
assert.equal(allClosed, true)

const preAborted = new AbortController()
preAborted.abort()
let cancelledLaunches = 0
const preAbortedPool = new BrowserSessionPool(async () => {
  cancelledLaunches++
  return fakeBrowser('unexpected')
})
await assert.rejects(preAbortedPool.launch({ ...first, signal: preAborted.signal }, true), /取消/)
assert.equal(cancelledLaunches, 0)
assert.equal(preAbortedPool.get(first), null)

let finishCancelledLaunch: ((browser: Browser) => void) | undefined
const cancelledPool = new BrowserSessionPool(() => new Promise((resolve) => { finishCancelledLaunch = resolve }))
const controller = new AbortController()
const cancelledCtx: ToolContext = { ...first, signal: controller.signal }
const cancelledLaunch = cancelledPool.launch(cancelledCtx, true)
controller.abort()
await assert.rejects(cancelledLaunch, /取消/)
assert.equal(cancelledPool.get(cancelledCtx), null)
finishCancelledLaunch?.(fakeBrowser('cancelled'))
await cancelledPool.closeAll()
assert.equal(cancelledPool.get(cancelledCtx), null)
assert.ok(closed.includes('cancelled'))

let finishPage: (() => void) | undefined
let pageBrowserClosed = 0
const pageBrowser = {
  newPage: () => new Promise((resolve) => { finishPage = () => resolve({}) }),
  close: async () => { pageBrowserClosed++ },
  on: () => {},
} as unknown as Browser
const pagePool = new BrowserSessionPool(async () => pageBrowser)
const pageController = new AbortController()
const pageCtx: ToolContext = { ...first, signal: pageController.signal }
const pageLaunch = pagePool.launch(pageCtx, true)
await new Promise((resolve) => setImmediate(resolve))
assert.ok(finishPage)
pageController.abort()
await assert.rejects(pageLaunch, /取消/)
finishPage?.()
await pagePool.closeAll()
assert.equal(pageBrowserClosed, 1)
assert.equal(pagePool.get(pageCtx), null)

let finishSharedLaunch: ((browser: Browser) => void) | undefined
let sharedLaunches = 0
const sharedPool = new BrowserSessionPool(async () => {
  sharedLaunches++
  if (sharedLaunches === 1) return new Promise((resolve) => { finishSharedLaunch = resolve })
  return fakeBrowser('replacement')
})
const owner = new AbortController()
const abandoned = sharedPool.launch({ ...first, signal: owner.signal }, true)
const waiting = sharedPool.launch(first, true)
owner.abort()
await assert.rejects(abandoned, /取消/)
finishSharedLaunch?.(fakeBrowser('abandoned'))
assert.equal(await waiting, true)
assert.equal(sharedLaunches, 2)
assert.ok(closed.includes('abandoned'))
assert.notEqual(sharedPool.get(first), null)
await sharedPool.closeAll()

console.log('browser_sessions_test passed')
