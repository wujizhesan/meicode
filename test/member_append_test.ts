import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { ChatMessage, Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { MemberHost } from '../src/team/member.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'text', text: 'MEMBER-ANSWER😀' }; yield { type: 'done' } } }
const base: ChatMessage[] = [{ role: 'user', content: 'OLD-USER😀' }, { role: 'assistant', content: 'OLD-ANSWER😀' }]
const endings: Record<string, string> = { lf: '\n', crlf: '\r\n', cr: '\r' }

for (const tail of ['none', 'lf', 'crlf', 'cr', 'empty', 'missing']) await check('成员历史 ' + tail + ' 尾行追加和再次恢复保留全部消息', async () => {
  const f = await streamFixture(provider), file = join(f.root, 'team', 'audit', 'members', 'alice.history.jsonl')
  const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  let recovered: MemberHost | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    const initial = tail === 'empty' || tail === 'missing' ? [] : base
    if (tail !== 'missing') fs.writeFileSync(file, initial.map((message) => JSON.stringify(message)).join('\n') + (endings[tail] ?? ''))
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, agentId: 'member-alice', roleDefinition: null })
    for (const task of ['NEW-TASK-A', 'NEW-TASK-B']) assert.equal((await bounded(host.execute(task, task))).status, 'done')
    const saved = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(saved, [...initial, { role: 'user', content: 'NEW-TASK-A' }, { role: 'assistant', content: 'MEMBER-ANSWER😀' }, { role: 'user', content: 'NEW-TASK-B' }, { role: 'assistant', content: 'MEMBER-ANSWER😀' }])
    recovered = new MemberHost({ name: 'recovered', role: 'worker', workdir: f.root, backend: 'coroutine', needsApproval: false, status: 'idle' },
      'audit', { provider, registry: f.registry, ctx: f.chat.getToolContext(), historyFile: file, store: {} as never, mail: {} as never })
    assert.deepEqual(recovered.history.view(), saved)
  } finally { recovered?.close(); await team.close(1000); await f.close() }
})

await check('末字节读取失败不追加或推进游标，关闭文件句柄且恢复后补存一次', async () => {
  const f = await streamFixture(provider), file = join(f.root, 'team', 'audit', 'members', 'alice.history.jsonl')
  const team = new TeamManager(join(f.root, 'team'), f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const original = { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync }
  const readFailed = deferred()
  let fd: number | undefined, closed = false
  const restore = () => { Object.assign(fs, original); syncBuiltinESMExports() }
  try {
    const group = team.createGroup('audit', 'lead'), before = base.map((message) => JSON.stringify(message)).join('\n')
    fs.writeFileSync(file, before)
    const host = await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, agentId: 'member-alice', roleDefinition: null })
    assert.deepEqual(host.history.view(), base)
    fs.openSync = ((path: unknown, ...args: unknown[]) => {
      const opened = (original.openSync as (...params: unknown[]) => number)(path, ...args)
      if (String(path) === file && args[0] === 'r') fd = opened
      return opened
    }) as typeof fs.openSync
    fs.readSync = ((opened: number, ...args: unknown[]) => {
      if (opened === fd) { readFailed.resolve(); return 0 }
      return (original.readSync as (...params: unknown[]) => number)(opened, ...args)
    }) as typeof fs.readSync
    fs.closeSync = (opened) => { if (opened === fd) closed = true; original.closeSync(opened) }
    syncBuiltinESMExports()
    const execution = host.execute('UNSAVED-TASK', 'unsaved-task')
    await bounded(readFailed.promise)
    assert(closed)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert(host.isBusy())
    restore()
    assert.equal((await bounded(execution)).status, 'done')
    assert.equal((await bounded(host.execute('RETRY-TASK', 'retry-task'))).status, 'done')
    assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), host.history.view())
    assert.equal(host.history.length, 6)
  } finally { restore(); await team.close(1000); await f.close() }
})

console.log('member_append_test: ' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
