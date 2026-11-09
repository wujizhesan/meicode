import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(probe: () => boolean, message: string, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() >= end) throw new Error(message)
    await new Promise((done) => setTimeout(done, 20))
  }
}

// 子进程启动后延迟写「迟到文件」。这个延迟必须明显大于
//「检测到 hook-started → team.close 真正杀掉子进程」的耗时——本用例要真起子进程并读写磁盘，
// 负载下这段会被拉长到秒级。原值 1500ms 只留约 1.3s 余量，注入 1600ms 停顿即复现误判。
//
// 同时必须保持 LATE_WRITE_MS < HOOK_TIMEOUT_MS：只有在这个前提下，
//「关闭后无迟到写入」才是在证明 team.close 杀掉了子进程，而不是 hook 自身超时兜底——
// 否则子进程会被超时杀掉，测试会假通过。
const LATE_WRITE_MS = 6000
const HOOK_TIMEOUT_MS = 12_000

for (const mode of ['blocking', 'async'] as const) {
  await check('团队关闭终止 ' + mode + ' 完成 Hook 子进程，不产生迟到写入', async () => {
    const hooks = new HookEngine([{ event: 'task_completed', once: true, async: mode === 'async', action: {
      type: 'command', command: `"${process.execPath}" -e "require('node:fs').writeFileSync('hook-started',String(process.pid));setTimeout(()=>{require('node:fs').writeFileSync('hook-late','POST-CLOSE')},${LATE_WRITE_MS})"`, timeout: HOOK_TIMEOUT_MS,
    } }])
    const fire = hooks.fire.bind(hooks)
    let signal: AbortSignal | undefined, models = 0
    hooks.fire = async (event, context, currentSignal) => { if (event === 'task_completed') signal = currentSignal; await fire(event, context, currentSignal) }
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'WORK-COMPLETED' }; yield { type: 'done' } } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let execution: Promise<string> | undefined, pid: number | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'HOOK-CLOSE', undefined, [], 2)
      execution = team.runTask(group, task, 'alice')
      const started = join(f.root, 'hook-started'), late = join(f.root, 'hook-late')
      await waitUntil(() => fs.existsSync(started), '团队 Hook 未在预期时间内启动')
      pid = Number(fs.readFileSync(started, 'utf8'))
      assert(Number.isInteger(pid) && pid > 0 && pid !== process.pid)
      assert(signal)
      assert.equal(signal.aborted, false)
      assert.equal(team.listTasks(group.name)[0].status, 'done')
      await bounded(team.close(1000))
      assert.equal(signal.aborted, true)
      assert.equal(await bounded(execution), 'WORK-COMPLETED')
      await waitUntil(() => { try { process.kill(pid!, 0); return false } catch { return true } }, '团队 Hook 退出超时')
      assert(!fs.existsSync(late))
      assert.equal(team.listTasks(group.name)[0].status, 'done')
      assert.equal(team.listTasks(group.name)[0].attempt, 1)
      assert.equal(models, 1)
    } finally {
      if (pid) { try { process.kill(pid, 0); process.kill(pid) } catch { } }
      await team.close(1000); await Promise.allSettled([execution]); await f.close()
    }
  })
}

for (const mode of ['error', 'unresolved'] as const) {
  await check('完成 Hook ' + mode + ' 保留已保存真实结果，不重新执行模型', async () => {
    const started = deferred(), gate = deferred()
    const hooks = new HookEngine([])
    let signal: AbortSignal | undefined, models = 0
    hooks.fire = async (event, _context, currentSignal) => {
      if (event !== 'task_completed') return
      signal = currentSignal; started.resolve()
      if (mode === 'error') throw new Error('COMPLETION-HOOK-ERROR')
      await gate.promise
    }
    const provider: Provider = { protocol: 'openai', async *streamChat() { models++; yield { type: 'text', text: 'REAL-RESULT' }; yield { type: 'done' } } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'HOOK-RESULT', undefined, [], 2)
      execution = team.runTask(group, task, 'alice')
      await bounded(started.promise)
      if (mode === 'unresolved') await bounded(team.close(0))
      assert.equal(await bounded(execution), 'REAL-RESULT')
      const final = team.listTasks(group.name)[0]
      assert.equal(final.status, 'done')
      assert.equal(final.result, 'REAL-RESULT')
      assert.equal(final.attempt, 1)
      assert.equal(final.nextRetryAt, undefined)
      if (mode === 'unresolved') assert.equal(signal?.aborted, true)
      assert.equal(models, 1)
    } finally { gate.resolve(); await team.close(1000); await Promise.allSettled([execution]); await f.close() }
  })
}

console.log(`team_completion_hook_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
