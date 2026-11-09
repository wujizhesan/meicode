import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('hook cleanup wait timeout')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['cancel', 'start-error'] as const) {
  await check('成员启动 ' + mode + ' 清理旧指令，保留其他成员及主会话的待注入状态', async () => {
    const marker = 'TASK-A-ONLY-HOOK-INSTRUCTION'
    const hooks = new HookEngine([
      { event: 'subagent_start', once: true, action: { type: 'inject_prompt', content: marker } },
      { event: 'round_start', action: { type: 'inject_prompt', content: 'KEEP-OTHER-SCOPE' } },
      ...(mode === 'cancel' ? [{ event: 'subagent_start' as const, once: true, action: { type: 'command' as const,
        command: `"${process.execPath}" -e "require('node:fs').writeFileSync('hook-started',String(process.pid));setTimeout(()=>{},5000)"`, timeout: 5000 } }] : []),
    ])
    if (mode === 'start-error') {
      const fire = hooks.fire.bind(hooks)
      let starts = 0
      hooks.fire = async (event, ctx, signal) => {
        await fire(event, ctx, signal)
        if (event === 'subagent_start' && ++starts === 1) throw new Error('START-ERROR')
      }
    }
    const requests: ChatMessage[][] = []
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      requests.push(structuredClone(messages))
      yield { type: 'text', text: 'MEMBER-B-DONE' }; yield { type: 'done' }
    } }
    const f = await streamFixture(provider, { hooks })
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    let execution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, agentId: 'member-alice', roleDefinition: null })
      await hooks.fire('round_start', { cwd: f.root, sessionId: f.memory.sessionId, agentId: 'other-member' })
      await hooks.fire('round_start', { cwd: f.root, sessionId: f.memory.sessionId, agentId: 'parent-probe' })
      const a = team.addTask(group.name, 'MEMBER-A'), b = team.addTask(group.name, 'MEMBER-B')
      execution = team.runTask(group, a, 'alice')
      let childPid: number | undefined
      if (mode === 'cancel') {
        const startedFile = join(f.root, 'hook-started')
        await waitUntil(() => existsSync(startedFile))
        childPid = Number(readFileSync(startedFile, 'utf8'))
        assert(Number.isInteger(childPid) && childPid > 0 && childPid !== process.pid)
        assert(team.cancelTask(group.name, a.id))
      }
      await bounded(execution)
      assert.equal(requests.length, 0)
      assert(!host.isBusy())
      assert.equal(await bounded(team.runTask(group, b, 'alice')), 'MEMBER-B-DONE')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].filter((message) => message.role === 'user').at(-1)?.content, 'MEMBER-B')
      assert(!requests[0].some((message) => message.content === marker))
      assert.deepEqual(hooks.collectInjections({ sessionId: f.memory.sessionId, agentId: 'other-member' }), ['KEEP-OTHER-SCOPE'])
      assert.deepEqual(hooks.collectInjections({ sessionId: f.memory.sessionId, agentId: 'parent-probe' }), ['KEEP-OTHER-SCOPE'])
      if (childPid) await waitUntil(() => { try { process.kill(childPid!, 0); return false } catch { return true } })
    } finally {
      await team.close(1000)
      await Promise.allSettled([execution])
      await f.close()
    }
  })
}

console.log(`member_hook_cleanup_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
