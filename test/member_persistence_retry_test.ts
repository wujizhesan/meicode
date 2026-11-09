import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check()) {
    if (Date.now() >= end) throw new Error('member persistence wait timeout')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['once', 'recover', 'cancel', 'close', 'recover-close'] as const) {
  await check('成员存档 ' + mode + ' 只补存历史，模型和写入效果各执行一次', async () => {
    const saveFailed = deferred()
    let models = 0, effects = 0, failures = 0, blocked = true
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      models++
      if (models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'WORK-ALREADY-COMPLETED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider)
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const originalAppend = fs.appendFileSync
    let execution: Promise<string> | undefined
    try {
      const effectsFile = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '隔离实际写入', parameters: { type: 'object' }, async execute() {
        effects++
        fs.appendFileSync(effectsFile, 'EFFECT\n', 'utf8')
        return { success: true, output: 'EFFECT-SAVED' }
      } })
      const group = team.createGroup('audit', 'lead')
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'WRITE-ONCE', undefined, [], 2)
      const historyFile = join(f.root, 'team', 'audit', 'members', 'alice.history.jsonl')
      fs.appendFileSync = ((file: unknown, ...args: unknown[]) => {
        if (String(file) === historyFile && blocked) {
          failures++
          if (mode === 'once') blocked = false
          saveFailed.resolve()
          throw Object.assign(new Error('MEMBER-HISTORY-EIO'), { code: 'EIO' })
        }
        return (originalAppend as (...params: unknown[]) => unknown)(file, ...args)
      }) as typeof fs.appendFileSync
      syncBuiltinESMExports()
      execution = team.runTask(group, task, 'alice')
      await bounded(saveFailed.promise)
      assert(host.isBusy())
      assert.equal(effects, 1)
      assert.equal(models, 2)
      assert.equal(team.listTasks(group.name).find((item) => item.id === task.id)?.status, 'in_progress')
      if (mode === 'recover') { await waitUntil(() => failures >= 3); blocked = false }
      if (mode === 'cancel') assert(team.cancelTask(group.name, task.id))
      if (mode === 'close') await bounded(team.close(1000))
      if (mode === 'recover-close') { blocked = false; await bounded(team.close(1000)) }
      const result = await bounded(execution)
      assert.match(result, /WORK-ALREADY-COMPLETED/)
      assert(!host.isBusy())
      const final = team.listTasks(group.name).find((item) => item.id === task.id)!
      assert.equal(final.status, mode === 'cancel' ? 'cancelled' : 'done')
      assert.equal(final.attempt, 1)
      assert.equal(final.nextRetryAt, undefined)
      assert.equal(effects, 1)
      assert.equal(models, 2)
      assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'EFFECT\n')
      blocked = false
      if (mode === 'close') host.close()
      await waitUntil(() => fs.existsSync(historyFile))
      const saved = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(saved, host.history.view())
      assert.equal(saved.filter((message) => message.role === 'user' && message.content === 'WRITE-ONCE').length, 1)
      assert.equal(saved.filter((message) => message.role === 'assistant' && message.content === 'WORK-ALREADY-COMPLETED').length, 1)
      assert.equal(models, 2)
    } finally {
      blocked = false
      fs.appendFileSync = originalAppend
      syncBuiltinESMExports()
      await team.close(1000)
      await Promise.allSettled([execution])
      await f.close()
    }
  })
}

await check('存档冲突保留已完成结果，保护外部历史并停止自动重跑', async () => {
  let models = 0, effects = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    models++
    if (models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'WORK-ALREADY-COMPLETED' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider)
  const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  try {
    const group = team.createGroup('audit', 'lead')
    const historyFile = join(f.root, 'team', 'audit', 'members', 'alice.history.jsonl')
    const external = JSON.stringify({ role: 'user', content: 'EXTERNAL-HISTORY' }) + '\n'
    f.registry.register({ name: 'write_file', description: '隔离实际写入', parameters: { type: 'object' }, async execute() {
      effects++
      fs.writeFileSync(historyFile, external)
      return { success: true, output: 'EFFECT-SAVED' }
    } })
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'WRITE-ONCE', undefined, [], 2)
    const result = await bounded(team.runTask(group, task, 'alice'))
    assert.match(result, /WORK-ALREADY-COMPLETED/)
    assert.match(result, /历史已被其他进程更新/)
    const saved = team.listTasks(group.name).find((item) => item.id === task.id)!
    assert.equal(saved.status, 'done')
    assert.equal(saved.attempt, 1)
    assert.equal(saved.nextRetryAt, undefined)
    assert(!host.isBusy())
    assert.equal(models, 2)
    assert.equal(effects, 1)
    assert.equal(fs.readFileSync(historyFile, 'utf8'), external)
  } finally { await team.close(1000); await f.close() }
})

console.log(`member_persistence_retry_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
