import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { SubAgentManager, SubAgentStore } from '../src/subagent/index.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import type { WorktreeManager } from '../src/worktree/index.ts'

let passed = 0
let failed = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_subagent_startup_'))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('启动回归超时')), 3000)
    })])
  } finally { clearTimeout(timer) }
}

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function fixture(name: string, worktrees?: WorktreeManager) {
  const directory = join(root, name)
  mkdirSync(directory)
  const dirs = { builtin: join(directory, 'builtin'), user: join(directory, 'user'), project: join(directory, 'roles') }
  const store = new SubAgentStore(join(directory, 'store'), name)
  const manager = new SubAgentManager(dirs, worktrees, store)
  return { directory, dirs, store, manager, ctx: { cwd: directory, sessionId: name, agentId: 'parent' }, registry: new ToolRegistry() }
}

function blockedHook(rejectLate = false) {
  const hooks = new HookEngine([])
  const started = deferred()
  const gate = deferred()
  let signal: AbortSignal | undefined
  const originalFire = hooks.fire.bind(hooks)
  hooks.fire = async (event, context, currentSignal) => {
    if (event === 'subagent_start') {
      signal = currentSignal
      started.resolve()
      await gate.promise
      if (rejectLate) throw new Error('LATE_STARTUP_HOOK_ERROR')
    }
    await originalFire(event, context, currentSignal)
  }
  return { hooks, started, gate, get signal() { return signal } }
}

try {
  for (const action of ['close', 'cancel', 'external'] as const) {
    await check(`${action} 覆盖启动 Hook 等待阶段，及时取消且迟到 Hook 不启动模型`, async () => {
      const f = fixture(action)
      const hook = blockedHook(action === 'cancel')
      let models = 0
      let notifications = 0
      f.manager.setOnResult(() => { notifications++ })
      const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: '不应启动' }; yield { type: 'done' } } }
      try {
        const submitted = await bounded(f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: { ...f.ctx, hooks: hook.hooks } }))
        await bounded(hook.started.promise)
        if (action === 'close') await bounded(f.manager.close(0))
        else if (action === 'cancel') assert(f.manager.cancel(submitted.id, f.ctx.sessionId))
        else f.store.requestCancel(submitted.id, '外部取消')
        const result = await bounded(f.manager.waitFor(submitted.id, 2000))
        assert.equal(result.timedOut, false)
        assert.equal(result.record?.status, 'cancelled')
        assert.equal(result.record?.ownerId, undefined)
        assert.equal(result.record?.leaseExpiresAt, undefined)
        assert(hook.signal?.aborted)
        assert.equal(models, 0)
        const before = f.store.get(submitted.id)
        const callbacks = notifications
        hook.gate.resolve()
        await new Promise<void>((done) => setImmediate(done))
        assert.deepEqual(f.store.get(submitted.id), before)
        assert.equal(models, 0)
        assert.equal(notifications, callbacks)
      } finally { hook.gate.resolve(); await bounded(f.manager.close(0)) }
    })
  }

  await check('关闭发生在启动 Hook 内时也已登记任务，且模型不会启动', async () => {
    const f = fixture('close-in-hook')
    const hooks = new HookEngine([])
    let models = 0
    hooks.fire = async (event) => { if (event === 'subagent_start') await f.manager.close(0) }
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
    try {
      const submitted = await bounded(f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: { ...f.ctx, hooks } }))
      const result = await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(result.record?.status, 'cancelled')
      assert.equal(models, 0)
      assert(f.manager.isClosed())
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('父请求在启动阶段取消会终止子任务并释放信号监听', async () => {
    const f = fixture('parent-abort')
    const hook = blockedHook()
    const controller = new AbortController()
    let models = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
    try {
      const submitted = await f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: { ...f.ctx, hooks: hook.hooks, signal: controller.signal } })
      await bounded(hook.started.promise)
      controller.abort()
      const result = await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(result.record?.status, 'cancelled')
      assert.equal(models, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    } finally { hook.gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('已启动的后台任务不被后续父请求取消，管理器仍可等待真实结果', async () => {
    const f = fixture('background-detached')
    const started = deferred()
    const gate = deferred()
    const controller = new AbortController()
    let childSignal: AbortSignal | undefined
    const provider: Provider = {
      protocol: 'openai',
      async *streamChat(_messages, options) {
        childSignal = options.signal
        started.resolve()
        await gate.promise
        yield { type: 'text', text: '后台完成' }
        yield { type: 'done' }
      },
    }
    try {
      const submitted = await f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: { ...f.ctx, signal: controller.signal } })
      await bounded(started.promise)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      controller.abort()
      assert.equal(childSignal?.aborted, false)
      gate.resolve()
      const result = await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(result.record?.status, 'done')
      assert.equal(result.record?.result, '后台完成')
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('启动 Hook 异常保存失败原因并收敛租约，模型不启动', async () => {
    const f = fixture('hook-error')
    const hooks = new HookEngine([])
    hooks.fire = async (event) => { if (event === 'subagent_start') throw new Error('STARTUP_HOOK_ERROR') }
    let models = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
    try {
      const submitted = await f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: { ...f.ctx, hooks } })
      const result = await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(result.record?.status, 'error')
      assert.equal(result.record?.error, 'STARTUP_HOOK_ERROR')
      assert.equal(result.record?.ownerId, undefined)
      assert.equal(result.record?.leaseExpiresAt, undefined)
      assert.equal(models, 0)
    } finally { await bounded(f.manager.close(0)) }
  })

  await check('关闭覆盖 worktree 创建等待阶段，迟到目录收尾后不启动模型', async () => {
    const started = deferred()
    const gate = deferred()
    const cleanup: string[] = []
    const worktrees = {
      async create(name: string) { started.resolve(); await gate.promise; return { path: join(root, name), branch: `wt-${name}` } },
      async exit(name: string) { cleanup.push(`exit:${name}`); return { dirty: false } },
      async remove(name: string) { cleanup.push(`remove:${name}`) },
      release(name: string) { cleanup.push(`release:${name}`) },
    } as unknown as WorktreeManager
    const f = fixture('worktree-close', worktrees)
    mkdirSync(f.dirs.project)
    writeFileSync(join(f.dirs.project, 'isolated.md'), '---\nname: isolated\ndescription: isolated\nisolation: worktree\n---\n任务\n')
    f.manager.loadRoles()
    let models = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
    try {
      const submitted = await f.manager.spawn({ type: 'defined', role: 'isolated', prompt: '任务', async: true }, { provider, registry: f.registry, ctx: f.ctx })
      await bounded(started.promise)
      await bounded(f.manager.close(0))
      assert.equal(f.store.get(submitted.id)?.status, 'cancelled')
      gate.resolve()
      await bounded(f.manager.waitFor(submitted.id, 2000))
      assert.equal(models, 0)
      assert.equal(f.store.get(submitted.id)?.status, 'cancelled')
      assert.equal(cleanup.filter((item) => item.startsWith('exit:')).length, 1)
      assert.equal(cleanup.filter((item) => item.startsWith('remove:')).length, 1)
      assert.equal(cleanup.filter((item) => item.startsWith('release:')).length, 1)
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('初始持久化失败不留下虚假运行记录，预先取消也不创建任务', async () => {
    const f = fixture('initial-error')
    f.store.save = () => { throw new Error('INITIAL_STORE_ERROR') }
    let models = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'done' } } }
    try {
      await assert.rejects(f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: f.ctx }), /INITIAL_STORE_ERROR/)
      assert.deepEqual(f.manager.listRecords(), [])
      const controller = new AbortController()
      controller.abort()
      const result = await f.manager.spawn({ type: 'fork', prompt: '任务' }, { provider, registry: f.registry, ctx: { ...f.ctx, signal: controller.signal } })
      assert.equal(result.id, '')
      assert(result.error?.includes('取消'))
      assert.equal(models, 0)
    } finally { await bounded(f.manager.close(0)) }
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_subagent_startup_'))
  const verify = (directory: string) => {
    assert(!lstatSync(directory).isSymbolicLink())
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) verify(join(directory, entry.name))
    }
  }
  verify(target)
  rmSync(target, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
