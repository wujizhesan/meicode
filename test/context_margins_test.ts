import assert from 'node:assert/strict'
import { ContextManager } from '../src/context/index.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

class CountingProvider implements Provider {
  readonly protocol = 'openai' as const
  requests = 0

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.requests++
    yield { type: 'text', text: '本地模拟摘要' }
    yield { type: 'done' }
  }
}

function fixture(window: number, margins: { autoMargin?: number; manualMargin?: number } = {}) {
  const history = new History()
  for (let index = 0; index < 10; index++) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}:` + 'x'.repeat(398) })
  const provider = new CountingProvider()
  const manager = new ContextManager({ provider, history, cwd: process.cwd(), window, ...margins })
  return { history, provider, manager }
}

await check('默认余量覆盖极小到大窗口，自动先于手动且阈值始终为正', () => {
  for (const window of [1, 2, 9, 10, 19, 20, 64, 512, 1000, 4096, 8192, 16384, 32768, 65536, 131072, 1048576]) {
    const { manager } = fixture(window)
    const { autoMargin, manualMargin } = manager.snapshot()
    assert(Number.isInteger(autoMargin) && Number.isInteger(manualMargin))
    assert(autoMargin >= manualMargin && manualMargin >= 0)
    assert(autoMargin <= window * 0.1 && autoMargin <= 13000)
    assert(manualMargin <= window * 0.05 && manualMargin <= 3000)
    assert(window - autoMargin > 0 && window - manualMargin > 0)
    if (window >= 131072) assert.deepEqual([autoMargin, manualMargin], [13000, 3000])
  }
  const budget = fixture(8192).manager.snapshot()
  assert.deepEqual([budget.autoMargin, budget.manualMargin], [819, 409])
})

for (const window of [4096, 8192, 16384, 131072]) {
  await check(`${window}: 1000 tokens 历史且无新增消息时，自动和手动都不反复摘要`, async () => {
    const { history, provider, manager } = fixture(window)
    const original = history.all()
    const version = history.version
    assert.equal(manager.snapshot().estimatedTokens, 1000)
    for (let round = 0; round < 3; round++) {
      await manager.beforeRequest('auto')
      assert.deepEqual(await manager.compact(), { status: 'skipped', reason: 'below_threshold' })
    }
    assert.equal(provider.requests, 0)
    assert.equal(history.version, version)
    assert.deepEqual(history.view(), original)
  })
}

for (const window of [4096, 8192]) {
  await check(`${window}: 自动阈值处不压缩，追加消息超过阈值后仅摘要一次`, async () => {
    const { history, provider, manager } = fixture(window)
    const threshold = window - manager.snapshot().autoMargin
    manager.afterRequest(threshold, history.length)
    await manager.beforeRequest('auto')
    assert.equal(provider.requests, 0)
    history.push({ role: 'user', content: '新' })
    assert.equal(manager.snapshot().estimatedTokens, threshold + 1)
    const recent = history.all().slice(-5)
    await manager.beforeRequest('auto')
    assert.equal(provider.requests, 1)
    assert.deepEqual(history.view().slice(-5), recent)
    assert.match(history.view()[0].content, /早期对话摘要/)
    const version = history.version
    for (let round = 0; round < 3; round++) await manager.beforeRequest('auto')
    assert.equal(provider.requests, 1)
    assert.equal(history.version, version)
    assert(manager.snapshot().estimatedTokens < threshold)
  })
}

await check('手动阈值边界正确，压缩后保留最近消息且无需再次摘要', async () => {
  const { history, provider, manager } = fixture(8192)
  const threshold = 8192 - manager.snapshot().manualMargin
  const recent = history.all().slice(-5)
  manager.afterRequest(threshold, history.length)
  assert.deepEqual(await manager.compact(), { status: 'skipped', reason: 'below_threshold' })
  manager.afterRequest(threshold + 1, history.length)
  assert.deepEqual(await manager.compact(), { status: 'compacted', summary: '本地模拟摘要' })
  assert.deepEqual(history.view().slice(-5), recent)
  assert.deepEqual(await manager.compact(), { status: 'skipped', reason: 'below_threshold' })
  assert.equal(provider.requests, 1)
})

await check('默认自动检查比手动检查更早触发', async () => {
  const { history, provider, manager } = fixture(8192)
  manager.afterRequest(7600, history.length)
  assert.deepEqual(await manager.compact(), { status: 'skipped', reason: 'below_threshold' })
  assert.equal(provider.requests, 0)
  await manager.beforeRequest('auto')
  assert.equal(provider.requests, 1)
  assert.match(history.view()[0].content, /早期对话摘要/)
})

await check('明确配置的余量及零余量按各自阈值生效', async () => {
  const configured = fixture(8192, { autoMargin: 2000, manualMargin: 1000 })
  assert.deepEqual([configured.manager.snapshot().autoMargin, configured.manager.snapshot().manualMargin], [2000, 1000])
  configured.manager.afterRequest(6500, configured.history.length)
  assert.deepEqual(await configured.manager.compact(), { status: 'skipped', reason: 'below_threshold' })
  await configured.manager.beforeRequest('auto')
  assert.equal(configured.provider.requests, 1)

  const zero = fixture(8192, { autoMargin: 0, manualMargin: 0 })
  assert.deepEqual([zero.manager.snapshot().autoMargin, zero.manager.snapshot().manualMargin], [0, 0])
  zero.manager.afterRequest(8192, zero.history.length)
  await zero.manager.beforeRequest('auto')
  assert.deepEqual(await zero.manager.compact(), { status: 'skipped', reason: 'below_threshold' })
  zero.manager.afterRequest(8193, zero.history.length)
  assert.equal((await zero.manager.compact()).status, 'compacted')
  assert.equal(zero.provider.requests, 1)

  const automaticOnly = fixture(8192, { autoMargin: 2000 }).manager.snapshot()
  assert.deepEqual([automaticOnly.autoMargin, automaticOnly.manualMargin], [2000, 409])
  const manualOnly = fixture(8192, { manualMargin: 1000 }).manager.snapshot()
  assert.deepEqual([manualOnly.autoMargin, manualOnly.manualMargin], [819, 1000])
})

console.log(`\ncontext_margins_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
