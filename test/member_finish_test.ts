import assert from 'node:assert/strict'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { HookEventName } from '../src/hook/types.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}

for (const event of ['subagent_stop', 'teammate_idle'] as const) {
  await check(event + ' 完成前保留忙碌、延迟会话切换，下一任务仍可取消', async () => {
    const started = deferred(), gate = deferred(), secondStarted = deferred(), secondGate = deferred()
    const sessions: { event: string; sessionId?: string }[] = []
    let hits = 0, secondSignal: AbortSignal | undefined
    const hooks = new HookEngine([])
    hooks.fire = async (current, payload) => {
      if (payload.role === 'member:worker') sessions.push({ event: current, sessionId: payload.sessionId })
      if (current === event && ++hits === 1) { started.resolve(); await gate.promise }
    }
    const requests: string[] = []
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      const title = messages.filter((message) => message.role === 'user').at(-1)!.content
      requests.push(title)
      if (title === 'MEMBER-B') {
        secondSignal = options.signal
        secondStarted.resolve()
        await resolveOnAbort(secondGate.promise, options.signal, undefined)
        if (options.signal?.aborted) return
      }
      yield { type: 'text', text: title + '-COMPLETED' }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let first: Promise<string> | undefined, second: Promise<string> | undefined
    try {
      const group = team.createGroup('finish', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const a = team.addTask(group.name, 'MEMBER-A'), b = team.addTask(group.name, 'MEMBER-B')
      first = team.runTask(group, a, 'alice')
      await bounded(started.promise)
      assert(host.isBusy())
      let idle = false
      const idleWait = host.whenIdle().then(() => { idle = true })
      await tick()
      assert.equal(idle, false)
      assert.match(await team.runTask(group, b, 'alice'), /正在执行其他任务/)
      assert.equal((await host.execute('MEMBER-DIRECT', 'direct')).status, 'failed')
      assert.deepEqual(requests, ['MEMBER-A'])
      assert.equal(team.listTasks(group.name).find((task) => task.id === b.id)?.status, 'todo')
      team.setSessionId('next-session')
      gate.resolve()
      await bounded(first)
      await bounded(idleWait)
      assert(!host.isBusy())
      assert(sessions.every((record) => record.sessionId === 'stream-test'))
      second = team.runTask(group, b, 'alice')
      await bounded(secondStarted.promise)
      assert(host.isBusy())
      assert(sessions.some((record) => record.event === 'subagent_start' && record.sessionId === 'next-session'))
      assert(team.cancelTask(group.name, b.id))
      assert.equal(secondSignal?.aborted, true)
      await bounded(second)
      assert(!host.isBusy())
      assert.equal(team.listTasks(group.name).find((task) => task.id === b.id)?.status, 'cancelled')
    } finally {
      gate.resolve()
      secondGate.resolve()
      await Promise.allSettled([first, second])
      await team.close(1000)
      await f.close()
    }
  })
}

for (const event of ['subagent_start', 'subagent_stop', 'teammate_idle'] as const) for (const action of ['cancel', 'close'] as const) {
  await check(event + ' 等待中 ' + action + ' 及时释放执行槽，迟到 Hook 不破坏新任务', async () => {
    const started = deferred(), gate = deferred(), late = deferred(), secondStarted = deferred(), secondGate = deferred()
    let hits = 0, signal: AbortSignal | undefined, secondSignal: AbortSignal | undefined
    const hooks = new HookEngine([])
    hooks.fire = async (current, _, currentSignal) => {
      if (current === event && ++hits === 1) {
        signal = currentSignal
        started.resolve()
        await gate.promise
        late.resolve()
        throw new Error('LATE-MEMBER-HOOK-ERROR')
      }
    }
    const requests: string[] = []
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      const title = messages.filter((message) => message.role === 'user').at(-1)!.content
      requests.push(title)
      if (title === 'MEMBER-B') {
        secondSignal = options.signal
        secondStarted.resolve()
        await resolveOnAbort(secondGate.promise, options.signal, undefined)
        if (options.signal?.aborted) return
      }
      yield { type: 'text', text: title + '-COMPLETED' }
      yield { type: 'done' }
    } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let first: Promise<string> | undefined, second: Promise<string> | undefined
    try {
      const group = team.createGroup('finish', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const a = team.addTask(group.name, 'MEMBER-A')
      first = team.runTask(group, a, 'alice')
      await bounded(started.promise)
      assert(host.isBusy())
      if (action === 'cancel') assert(team.cancelTask(group.name, a.id))
      else await bounded(team.close(1000))
      assert.equal(signal?.aborted, true)
      await bounded(first)
      assert(!host.isBusy())
      if (event === 'subagent_start') assert.equal(requests.length, 0)
      if (action === 'cancel') {
        assert.equal(team.listTasks(group.name).find((task) => task.id === a.id)?.status, 'cancelled')
        const b = team.addTask(group.name, 'MEMBER-B')
        second = team.runTask(group, b, 'alice')
        await bounded(secondStarted.promise)
        gate.resolve()
        await bounded(late.promise)
        await tick()
        assert(host.isBusy())
        assert.equal(secondSignal?.aborted, false)
        assert(host.cancel(b.id))
        assert.equal(secondSignal?.aborted, true)
        await bounded(second)
        assert(!host.isBusy())
      } else {
        gate.resolve()
        await bounded(late.promise)
        await tick()
        assert(!host.isBusy())
      }
    } finally {
      gate.resolve()
      secondGate.resolve()
      await Promise.allSettled([first, second])
      await team.close(1000)
      await f.close()
    }
  })
}

await check('结束 Hook 异常仍释放成员和空闲等待器，后续任务可执行', async () => {
  const hooks = new HookEngine([])
  let stops = 0
  hooks.fire = async (event: HookEventName) => { if (event === 'subagent_stop' && ++stops === 1) throw new Error('STOP-ERROR') }
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider, { hooks })
  const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  try {
    const group = team.createGroup('finish', 'lead')
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const execution = host.execute('MEMBER-A', 'a')
    const idle = host.whenIdle()
    await assert.rejects(execution, /STOP-ERROR/)
    await bounded(idle)
    assert(!host.isBusy())
    assert.equal((await host.execute('MEMBER-B', 'b')).status, 'done')
  } finally { await team.close(1000); await f.close() }
})

console.log(`member_finish_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
