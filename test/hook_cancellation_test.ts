import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runAgent } from '../src/agent/loop.ts'
import { executeToolCall } from '../src/agent/tool-execution.ts'
import { HookEngine } from '../src/hook/engine.ts'
import { runCommandAction, runHttpAction, setSubagentSpawner } from '../src/hook/runner.ts'
import type { HookRule } from '../src/hook/types.ts'
import type { PermissionContext } from '../src/permission/types.ts'
import type { Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { ToolRegistry } from '../src/tools/index.ts'

let passed = 0
let failed = 0

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

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function boundedWith<T>(limitMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('取消未及时完成')), limitMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// 默认 3s：取消类用例断言的就是"及时终止"，这里卡得紧才有意义。
// 需要跑正常命令的用例请用 boundedWith 单独放宽，别把取消断言的强度一起稀释掉。
async function bounded<T>(promise: Promise<T>): Promise<T> {
  return boundedWith(3000, promise)
}

async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!condition()) {
    if (Date.now() >= end) throw new Error('未观察到预期进程状态')
    await delay(20)
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

async function processFixture(test: (fixture: { root: string; command: string; ready(): Promise<void>; stopped(): Promise<void> }) => Promise<void>) {
  const root = mkdtempSync(join(import.meta.dirname, 'fixtures_hook_cancel_'))
  const script = join(root, 'wait hook.cjs')
  writeFileSync(script, `
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv[2] === 'child') {
  writeFileSync(join(__dirname, 'child.pid'), String(process.pid));
} else {
  require('node:child_process').spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(join(__dirname, 'parent.pid'), String(process.pid));
}
setInterval(() => {}, 1000);
`)
  const pids = () => ['parent.pid', 'child.pid'].filter((file) => existsSync(join(root, file))).map((file) => Number(readFileSync(join(root, file), 'utf8')))
  try {
    await test({
      root, command: `"${process.execPath}" "${script}"`,
      ready: () => until(() => pids().length === 2),
      stopped: () => until(() => pids().every((pid) => !processAlive(pid))),
    })
  } finally {
    for (const pid of pids()) {
      if (processAlive(pid)) process.kill(pid)
    }
    await until(() => pids().every((pid) => !processAlive(pid)))
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_hook_cancel_'))
    assert(!lstatSync(target).isSymbolicLink())
    assert(readdirSync(target, { withFileTypes: true }).every((entry) => !entry.isSymbolicLink() && !entry.isDirectory()))
    // 即使已等待进程退出，Windows 仍会短暂持有目录句柄 → EBUSY（CI 的 windows runner 实测）。
    // rmSync 自带的 maxRetries 是同步阻塞重试，不让出事件循环，OS 反而没有机会释放句柄；
    // 这里改为异步退避重试。用 break 而非 return —— finally 里 return 会吞掉测试体的断言失败。
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        rmSync(target, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 99) console.warn(`[hook_cancellation] 夹具清理失败，留待下一轮回收: ${String(error)}`)
        else await delay(100)
      }
    }
  }
}

for (const stage of ['round_start', 'tool_after', 'round_end'] as const) {
  await check(`${stage} Hook 忽略信号时取消仍及时结束并观察迟到错误`, async () => {
    const started = deferred()
    const gate = deferred()
    const seen: string[] = []
    let hookSignal: AbortSignal | undefined
    const hooks = new HookEngine([])
    hooks.fire = async (event, _context, signal) => {
      seen.push(event)
      if (event === stage) { hookSignal = signal; started.resolve(); await gate.promise }
    }
    const history = new History()
    history.push({ role: 'user', content: '取消 Hook 等待' })
    const registry = new ToolRegistry()
    let toolRuns = 0
    registry.register({ name: 'read_file', description: 'read', parameters: { type: 'object' }, async execute() { toolRuns++; return { success: true, output: '读取完成' } } })
    let requests = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      requests++
      if (stage === 'tool_after') yield { type: 'tool_call', id: 'read', name: 'read_file', arguments: {} }
      else yield { type: 'text', text: '主流程完成' }
      yield { type: 'done' }
    } }
    const agent = runAgent({ provider, history, registry, ctx: { cwd: process.cwd(), hooks }, maxIterations: 1, mode: 'full', systemPrompt: '取消测试', unknownToolLimit: 2 })
    try {
      await bounded(started.promise)
      agent.cancel()
      assert.equal((await bounded(agent.done)).reason, 'cancelled')
      assert(hookSignal?.aborted)
      assert.equal(getEventListeners(hookSignal!, 'abort').length, 0)
      assert.equal(requests, stage === 'round_start' ? 0 : 1)
      assert.equal(toolRuns, stage === 'tool_after' ? 1 : 0)
      if (stage !== 'round_end') assert(!seen.includes('round_end'))
      if (stage === 'tool_after') assert.equal(history.view().at(-1)?.tool_call_id, 'read')
      const snapshot = JSON.stringify(history.view())
      gate.reject(new Error('迟到 Hook 拒绝'))
      await delay(0)
      assert.equal(JSON.stringify(history.view()), snapshot)
    } finally {
      gate.resolve()
      agent.cancel()
      await bounded(agent.done)
    }
  })
}

for (const stage of ['permission_request', 'permission_denied', 'tool_before'] as const) {
  await check(`${stage} 等待可取消，不开始权限询问或工具执行`, async () => {
    const controller = new AbortController()
    const started = deferred()
    const gate = deferred()
    const hooks = new HookEngine([])
    if (stage === 'tool_before') hooks.intercept = async () => { started.resolve(); await gate.promise; return null }
    else hooks.fire = async (event, _context, signal) => {
      if (event === stage) { assert.equal(signal, controller.signal); started.resolve(); await gate.promise }
    }
    const registry = new ToolRegistry()
    let runs = 0
    let asks = 0
    registry.register({ name: 'write_file', description: 'write', parameters: { type: 'object' }, async execute() { runs++; return { success: true, output: '完成' } } })
    const permission: PermissionContext | undefined = stage === 'tool_before' ? undefined : {
      mode: 'default',
      engine: {
        match: () => stage === 'permission_denied' ? { tool: 'write_file', pattern: '*', action: 'deny', source: 'project' } : null,
        addSessionRule: () => {}, appendProjectRule: () => {},
      },
    }
    const pending = executeToolCall({ type: 'tool_call', id: 'write', name: 'write_file', arguments: { path: 'test-output.txt' } }, registry, {
      cwd: process.cwd(), signal: controller.signal, hooks, permission,
      ask: async () => { asks++; return 'once' },
    })
    try {
      await bounded(started.promise)
      controller.abort()
      const result = await bounded(pending)
      assert(!result.success)
      assert.equal(result.error, '工具执行已取消')
      assert.equal(asks, 0)
      assert.equal(runs, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      gate.reject(new Error('迟到权限 Hook 拒绝'))
      await delay(0)
      assert.equal(runs, 0)
    } finally {
      gate.resolve()
      controller.abort()
      await bounded(pending)
    }
  })
}

await check('预先取消不注入 prompt、不触发拦截且不消耗 once', async () => {
  const controller = new AbortController()
  controller.abort()
  const rules: HookRule[] = [
    { event: 'round_start', once: true, action: { type: 'inject_prompt', content: '一次提示' } },
    { event: 'tool_before', once: true, action: { type: 'command', command: 'echo blocked' } },
  ]
  const engine = new HookEngine(rules)
  await engine.fire('round_start', { cwd: process.cwd() }, controller.signal)
  assert.equal(await engine.intercept({ name: 'write_file', args: {} }, process.cwd(), controller.signal), null)
  assert.deepEqual(engine.collectInjections(), [])
  assert(rules.every((rule) => !rule.fired))
  await engine.fire('round_start', { cwd: process.cwd() })
  assert.deepEqual(engine.collectInjections(), ['一次提示'])
})

await check('取消真实 Hook 命令终止整棵进程树并清除监听', async () => {
  await processFixture(async (f) => {
    const controller = new AbortController()
    const pending = runCommandAction(f.command, f.root, 10000, undefined, controller.signal)
    try {
      await f.ready()
      controller.abort()
      await bounded(pending)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      await f.stopped()
    } finally {
      controller.abort()
      await bounded(pending)
    }
  })
})

await check('Hook 命令超时也终止孙进程', async () => {
  await processFixture(async (f) => {
    const controller = new AbortController()
    const pending = runCommandAction(f.command, f.root, 1500, undefined, controller.signal)
    try {
      await f.ready()
      await bounded(pending)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      await f.stopped()
    } finally {
      controller.abort()
      await bounded(pending)
    }
  })
})

await check('取消停止后续规则，未启动的 once 规则下次仍可执行', async () => {
  await processFixture(async (f) => {
    const controller = new AbortController()
    let runs = 0
    setSubagentSpawner(() => { runs++ })
    const rules: HookRule[] = [
      { event: 'round_start', once: true, action: { type: 'command', command: f.command } },
      { event: 'round_start', once: true, action: { type: 'subagent', name: 'next' } },
    ]
    const engine = new HookEngine(rules)
    const pending = engine.fire('round_start', { cwd: f.root }, controller.signal)
    try {
      await f.ready()
      controller.abort()
      await bounded(pending)
      await f.stopped()
      assert.equal(runs, 0)
      assert(!rules[1].fired)
      await engine.fire('round_start', { cwd: f.root })
      await engine.fire('round_start', { cwd: f.root })
      assert.equal(runs, 1)
    } finally {
      controller.abort()
      await bounded(pending)
      setSubagentSpawner(() => {})
    }
  })
})

await check('async Hook 命令也响应取消', async () => {
  await processFixture(async (f) => {
    const controller = new AbortController()
    const engine = new HookEngine([{ event: 'round_start', async: true, action: { type: 'command', command: f.command } }])
    try {
      await bounded(engine.fire('round_start', { cwd: f.root }, controller.signal))
      await f.ready()
      controller.abort()
      await f.stopped()
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    } finally {
      controller.abort()
    }
  })
})

await check('预先取消的命令不启动进程，正常命令仍返回截断输出', async () => {
  await processFixture(async (f) => {
    const controller = new AbortController()
    controller.abort()
    assert.equal(await runCommandAction(f.command, f.root, 1000, undefined, controller.signal), '')
    assert(!existsSync(join(f.root, 'parent.pid')))
    const active = new AbortController()
    // 这条用例验的是"截断到 500 字符"，不是"多快跑完"。原来给 2s 超时，在 Windows
    // 上偶发被冷启动 cmd+node 吃光，超时后 terminate 拿到空串，断言随机变红
    // （main 绿、dev 红，同一 commit）。放宽到 10s，仍远小于 boundedWith 的 15s 兜底。
    const output = await boundedWith(15000, runCommandAction(`"${process.execPath}" -e "process.stdout.write('x'.repeat(2000))"`, f.root, 10000, undefined, active.signal))
    assert.equal(output, 'x'.repeat(500))
    assert.equal(getEventListeners(active.signal, 'abort').length, 0)
  })
})

await check('HTTP Hook 接入取消信号，取消不发警告且不启动新请求', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  const controller = new AbortController()
  let calls = 0
  let requestSignal: AbortSignal | null | undefined
  globalThis.fetch = async (_input, init) => {
    calls++
    requestSignal = init?.signal
    return new Promise<Response>((_, reject) => {
      requestSignal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true })
    })
  }
  console.warn = (...args) => { warnings.push(args) }
  try {
    runHttpAction({ type: 'http', url: 'http://127.0.0.1/hook' }, controller.signal)
    assert.equal(requestSignal, controller.signal)
    controller.abort()
    await delay(0)
    runHttpAction({ type: 'http', url: 'http://127.0.0.1/hook' }, controller.signal)
    assert.equal(calls, 1)
    assert.deepEqual(warnings, [])
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    controller.abort()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
