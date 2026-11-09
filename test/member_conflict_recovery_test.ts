import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { bounded, streamFixture, tick } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  // 预算是等待上限而非耗时：条件满足即返回，只有真失败才会走满。
  // 2500ms 在 CI 负载下会偶发超时，与其它恢复等待统一放宽。
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('成员历史恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

for (const mode of ['auto', 'manual', 'copy-failure', 'cancel-recovery'] as const) {
  await check('成员历史冲突 ' + mode + ' 保存副本并恢复后续任务，不重复效果或消耗重试', async () => {
    let models = 0, effects = 0, faults = 0, blocked = mode === 'copy-failure' || mode === 'cancel-recovery'
    const requests: ChatMessage[][] = []
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      models++; requests.push(structuredClone(messages))
      if (models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: models === 2 ? 'FIRST-COMPLETED' : 'SECOND-COMPLETED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider)
    const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
    const original = fs.renameSync
    let laterExecution: Promise<string> | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const file = join(f.root, 'team', 'audit', 'members', 'alice.history.jsonl')
      const external = JSON.stringify({ role: 'user', content: 'EXTERNAL-HISTORY' }) + '\n'
      f.registry.register({ name: 'write_file', description: '隔离效果', parameters: { type: 'object' }, async execute() {
        effects++; fs.writeFileSync(file, external); return { success: true, output: 'EFFECT-SAVED' }
      } })
      fs.renameSync = ((source, destination) => {
        if (String(destination).startsWith(`${file}.conflict.`) && String(source).endsWith('.tmp') && blocked) {
          faults++; throw Object.assign(new Error('MEMBER-COPY-EIO'), { code: 'EIO' })
        }
        return original(source, destination)
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const first = team.addTask(group.name, 'FIRST-TASK', undefined, [], 2)
      const result = await bounded(team.runTask(group, first, 'alice'))
      assert.match(result, /FIRST-COMPLETED/)
      assert.equal(team.listTasks(group.name)[0].status, 'done')
      const unsaved = structuredClone(host.history.view())
      assert.equal(fs.readFileSync(file, 'utf8'), external)
      assert.equal(models, 2)
      if (mode === 'manual') host.reloadHistory()
      const later = team.addTask(group.name, 'SECOND-TASK', undefined, [], 2)
      laterExecution = team.runTask(group, later, 'alice')
      if (blocked) {
        await waitUntil(() => faults >= 4)
        assert(host.isBusy())
        assert.equal(models, 2)
        assert.equal(team.listTasks(group.name)[1].status, 'in_progress')
        assert.equal(team.listTasks(group.name)[1].attempt, 1)
        assert.throws(() => host.reloadHistory(), /不能重载/)
        assert.deepEqual(host.history.view(), unsaved)
        if (mode === 'cancel-recovery') {
          assert(team.cancelTask(group.name, later.id))
          await bounded(laterExecution)
          assert.equal(team.listTasks(group.name)[1].status, 'cancelled')
          assert.equal(models, 2)
          blocked = false
          host.reloadHistory()
          const third = team.addTask(group.name, 'THIRD-TASK', undefined, [], 2)
          laterExecution = team.runTask(group, third, 'alice')
        } else blocked = false
      }
      assert.match(await bounded(laterExecution), /SECOND-COMPLETED/)
      await tick()
      const final = team.listTasks(group.name).at(-1)!
      assert.equal(final.status, 'done')
      assert.equal(final.attempt, 1)
      assert.equal(final.nextRetryAt, undefined)
      assert.equal(models, 3)
      assert.equal(effects, 1)
      assert(requests[2].some((message) => message.content === 'EXTERNAL-HISTORY'))
      assert(!requests[2].some((message) => message.content === 'FIRST-COMPLETED'))
      const copies = fs.readdirSync(join(f.root, 'team', 'audit', 'members')).filter((name) => name.includes('.conflict.') && name.endsWith('.jsonl'))
      assert.equal(copies.length, 1)
      const savedCopy = fs.readFileSync(join(f.root, 'team', 'audit', 'members', copies[0]), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(savedCopy, unsaved)
      const saved = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(saved[0].content, 'EXTERNAL-HISTORY')
      assert.equal(saved.filter((message) => message.content === 'SECOND-COMPLETED').length, 1)
      assert(!host.isBusy())
    } finally {
      blocked = false; fs.renameSync = original; syncBuiltinESMExports()
      await team.close(1000); await Promise.allSettled([laterExecution]); await f.close()
    }
  })
}

console.log(`member_conflict_recovery_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
