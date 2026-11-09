import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('任务创建 Hook 退出超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['blocking', 'async'] as const) for (const action of ['close', 'parent-abort'] as const) {
  await check('创建 Hook ' + mode + ' ' + action + ' 终止真实命令进程且不产生迟到写入', async () => {
    const hooks = new HookEngine([{ event: 'task_created', once: true, async: mode === 'async', action: {
      type: 'command', command: `"${process.execPath}" -e "require('node:fs').writeFileSync('created-started',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('created-late','POST-CLOSE'),1500)"`, timeout: 3000,
    } }])
    const fire = hooks.fire.bind(hooks), parent = new AbortController()
    let signal: AbortSignal | undefined
    hooks.fire = async (event, context, currentSignal) => { if (event === 'task_created') signal = currentSignal; await fire(event, context, currentSignal) }
    const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: { ...f.chat.getToolContext(), signal: parent.signal } })
    let pid: number | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const started = join(f.root, 'created-started'), late = join(f.root, 'created-late')
      const task = team.addTask(group.name, 'CREATED-HOOK')
      await waitUntil(() => fs.existsSync(started))
      pid = Number(fs.readFileSync(started, 'utf8'))
      assert(Number.isInteger(pid) && pid > 0 && pid !== process.pid)
      assert.equal(signal?.aborted, false)
      if (action === 'close') await bounded(team.close(1000))
      else parent.abort()
      assert.equal(signal?.aborted, true)
      await waitUntil(() => { try { process.kill(pid!, 0); return false } catch { return true } })
      assert(!fs.existsSync(late))
      assert.equal(team.listTasks(group.name)[0].id, task.id)
      assert.equal(team.listTasks(group.name)[0].status, 'todo')
      assert.equal(team.listTasks(group.name)[0].attempt, 0)
    } finally {
      if (pid) {
        try { process.kill(pid, 0); process.kill(pid) } catch { }
        await waitUntil(() => { try { process.kill(pid!, 0); return false } catch { return true } })
      }
      await team.close(1000); await f.close()
    }
  })
}

for (const mode of ['error', 'unresolved'] as const) {
  await check('创建 Hook ' + mode + ' 不阻断任务保存，关闭及时返回且无未处理拒绝', async () => {
    const started = deferred(), gate = deferred(), unhandled: unknown[] = []
    const observe = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', observe)
    let signal: AbortSignal | undefined
    const hooks = new HookEngine([])
    hooks.fire = async (event, _context, currentSignal) => {
      if (event !== 'task_created') return
      signal = currentSignal; started.resolve()
      if (mode === 'error') throw new Error('CREATION-HOOK-ERROR')
      await gate.promise
    }
    const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    try {
      const group = team.createGroup('audit', 'lead'), task = team.addTask('audit', 'CREATED-HOOK')
      await bounded(started.promise)
      assert.equal(team.listTasks(group.name)[0].id, task.id)
      assert.equal(team.listTasks(group.name)[0].status, 'todo')
      await bounded(team.close(0))
      assert.equal(signal?.aborted, true)
      gate.resolve(); await tick(); await tick()
      assert.deepEqual(unhandled, [])
    } finally { gate.resolve(); await team.close(1000); await f.close(); process.removeListener('unhandledRejection', observe) }
  })
}

console.log(`team_creation_hook_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
