import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0
let failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name + ': ' + String(error)) }
}
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
const base: ChatMessage[] = [{ role: 'user', content: 'MEMBER-BASE-USER' }, { role: 'assistant', content: 'MEMBER-BASE-ANSWER' }]

for (const fault of ['read', 'stat', 'lock', 'execute-read']) await check('成员恢复 ' + fault + ' 失败后重试加载旧历史，不重复并正确追加', async () => {
  const requests: ChatMessage[][] = []
  const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
    requests.push(structuredClone(messages))
    yield { type: 'text', text: 'MEMBER-NEW-ANSWER' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const originalRead = fs.readFileSync, originalStat = fs.statSync, originalWrite = fs.writeFileSync
  const file = join(f.root, 'team', 'audit', 'members', 'alice.history.jsonl')
  const restore = () => { fs.readFileSync = originalRead; fs.statSync = originalStat; fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
  const fail = () => { throw Object.assign(new Error('MEMBER-RESTORE-FAILURE'), { code: 'EACCES' }) }
  try {
    const group = team.createGroup('audit', 'lead')
    writeFileSync(file, base.map((message) => JSON.stringify(message)).join('\n') + '\n')
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, agentId: 'member-alice', roleDefinition: null })
    if (fault === 'read' || fault === 'execute-read') {
      fs.readFileSync = ((path: unknown, ...args: unknown[]) => String(path) === file ? fail()
        : (originalRead as (...params: unknown[]) => unknown)(path, ...args)) as typeof fs.readFileSync
    } else if (fault === 'stat') {
      fs.statSync = ((path: unknown, ...args: unknown[]) => String(path) === file ? fail()
        : (originalStat as (...params: unknown[]) => unknown)(path, ...args)) as typeof fs.statSync
    } else {
      fs.writeFileSync = ((path: unknown, ...args: unknown[]) => String(path) === file + '.lock' ? fail()
        : (originalWrite as (...params: unknown[]) => unknown)(path, ...args)) as typeof fs.writeFileSync
    }
    syncBuiltinESMExports()
    if (fault === 'execute-read') {
      await assert.rejects(bounded(host.execute('FAILED-TASK', 'failed-task')), /MEMBER-RESTORE-FAILURE/)
      assert.equal(host.isBusy(), false)
      assert.equal(requests.length, 0)
    } else assert.throws(() => host.resume(), /MEMBER-RESTORE-FAILURE/)
    restore()
    assert.deepEqual(host.history.view(), base)
    host.resume()
    assert.deepEqual(host.history.view(), base)
    assert.equal((await bounded(host.execute('MEMBER-NEW-TASK', 'member-task'))).status, 'done')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].filter((message) => message.content === 'MEMBER-BASE-USER').length, 1)
    assert.equal(requests[0].filter((message) => message.content === 'MEMBER-BASE-ANSWER').length, 1)
    assert(!requests[0].some((message) => message.content === 'FAILED-TASK'))
    const saved = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(saved, [...base, { role: 'user', content: 'MEMBER-NEW-TASK' }, { role: 'assistant', content: 'MEMBER-NEW-ANSWER' }])
  } finally { restore(); await team.close(1000); await f.close() }
})

console.log('member_recovery_test: ' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
