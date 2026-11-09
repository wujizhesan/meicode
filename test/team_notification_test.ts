import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager } from '../src/team/index.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  // 预算是等待上限而非耗时：条件满足即返回，只有真失败才会走满。
  // 2500ms 在 CI 负载下会偶发超时，与其它恢复等待统一放宽。
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() >= end) throw new Error('团队通知恢复超时')
    await new Promise((done) => setTimeout(done, 20))
  }
}

const scenarios = [
  { status: 'done', mode: 'send-timer' }, { status: 'done', mode: 'send-restart' },
  { status: 'cancelled', mode: 'send-timer' }, { status: 'cancelled', mode: 'send-restart' },
  { status: 'failed', mode: 'send-restart' }, { status: 'done', mode: 'ack-restart' },
  { status: 'done', mode: 'append-restart' }, { status: 'done', mode: 'competing' },
  { status: 'done', mode: 'partial-restart' }, { status: 'done', mode: 'no-newline-restart' },
  { status: 'done', mode: 'read-restart' },
] as const

for (const { status, mode } of scenarios) {
  await check('团队通知 ' + status + ' ' + mode + ' 恢复只投递一次且不重复执行真实写入', async () => {
    const started = deferred(), gate = deferred()
    let models = 0, effects = 0, hooksRun = 0, appendBlocked = mode.startsWith('send') || mode === 'competing'
    let ackBlocked = !mode.startsWith('send'), postAppendBlocked = mode === 'append-restart'
    let partialBlocked = mode === 'partial-restart', noNewlineBlocked = mode === 'no-newline-restart', readBlocked = false
    const hooks = new HookEngine([])
    hooks.fire = async (event) => { if (event === 'task_completed') hooksRun++ }
    const provider: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
      models++; started.resolve()
      if (status === 'failed') throw new Error('REAL-MODEL-FAILURE')
      if (status === 'cancelled') await resolveOnAbort(gate.promise, options.signal, undefined)
      if (options.signal?.aborted) return
      if (status === 'done' && models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
      else { yield { type: 'text', text: 'WORK-COMPLETED' }; yield { type: 'done' } }
    } }
    const f = await streamFixture(provider, { hooks })
    const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
    const options = { provider, registry: f.registry, ctx: f.chat.getToolContext() }
    const team = new TeamManager(teamRoot, f.root, options)
    const originalAppend = fs.appendFileSync, originalRename = fs.renameSync, originalStat = fs.statSync
    let execution: Promise<string> | undefined, fresh: TeamManager | undefined
    try {
      const group = team.createGroup('audit', 'lead')
      const effectsFile = join(f.root, 'effects.log')
      f.registry.register({ name: 'write_file', description: '隔离真实写入', parameters: { type: 'object' }, async execute() {
        effects++; fs.appendFileSync(effectsFile, 'EFFECT\n', 'utf8'); return { success: true, output: 'EFFECT-SAVED' }
      } })
      await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
      const task = team.addTask(group.name, 'NOTIFICATION-EIO', undefined, [], 1)
      const taskFile = join(teamRoot, 'audit', 'tasks.json')
      fs.appendFileSync = ((file, data, options) => {
        const mail = String(file).startsWith(join(teamRoot, '_shared', 'mail')) && /"kind":"task_(result|cancelled)"/.test(String(data))
        if (mail && appendBlocked) throw Object.assign(new Error('MAIL-EIO'), { code: 'EIO' })
        if (mail && (partialBlocked || noNewlineBlocked)) {
          originalAppend(file, partialBlocked ? String(data).slice(0, 30) : String(data).trimEnd(), options)
          throw Object.assign(new Error('PARTIAL-APPEND-EIO'), { code: 'EIO' })
        }
        const result = originalAppend(file, data, options)
        if (mail && postAppendBlocked) throw Object.assign(new Error('POST-APPEND-EIO'), { code: 'EIO' })
        return result
      }) as typeof fs.appendFileSync
      fs.renameSync = ((source, destination) => {
        if (ackBlocked && String(destination) === taskFile && String(source).endsWith('.tmp')) {
          const records = JSON.parse(fs.readFileSync(source, 'utf8'))
          if (records.some((item: { id: string; status: string; notifications?: unknown[] }) => item.id === task.id && item.status === status && !item.notifications?.length)) {
            throw Object.assign(new Error('MAIL-ACK-EIO'), { code: 'EIO' })
          }
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      fs.statSync = ((file, options) => {
        if (readBlocked && String(file).startsWith(join(teamRoot, '_shared', 'mail')) && String(file).endsWith('.mail')) throw Object.assign(new Error('MAIL-READ-EIO'), { code: 'EIO' })
        return originalStat(file, options)
      }) as typeof fs.statSync
      syncBuiltinESMExports()
      execution = team.runTask(group, task, 'alice')
      await bounded(started.promise)
      if (status === 'cancelled') assert(team.cancelTask(group.name, task.id))
      await bounded(execution)
      const saved = store.listTasks(group.name)[0]
      assert.equal(saved.status, status)
      assert.equal(saved.attempt, 1)
      assert.equal(saved.notifications?.length, 1)
      const notification = saved.notifications![0]
      assert.equal(notification.correlationId, saved.reportId)
      assert.equal(notification.taskId, task.id)
      assert.equal(team.readLeadMail().filter((message) => message.taskId === task.id).length, appendBlocked || partialBlocked ? 0 : 1)
      assert.deepEqual(store.loadTaskSettlements(group.name), [])
      if (mode === 'competing') {
        fresh = new TeamManager(teamRoot, f.root, options)
        appendBlocked = false
        fresh.listTasks(group.name); team.listTasks(group.name); fresh.listTasks(group.name)
        assert.equal(fresh.readLeadMail().filter((message) => message.taskId === task.id).length, 1)
        assert.equal(store.listTasks(group.name)[0].notifications?.length, 1)
      } else if (mode !== 'send-timer') {
        await team.close(1000)
        readBlocked = mode === 'read-restart'
        fresh = new TeamManager(teamRoot, f.root, options)
        await fresh.restore([])
        assert.equal(store.listTasks(group.name)[0].notifications?.[0].messageId, notification.messageId)
        assert.equal(fresh.listTasks(group.name)[0].status, status)
      }
      appendBlocked = false; ackBlocked = false; postAppendBlocked = false; partialBlocked = false; noNewlineBlocked = false; readBlocked = false
      const target = fresh ?? team
      if (mode === 'send-timer') await waitUntil(() => !store.listTasks(group.name)[0].notifications)
      else target.listTasks(group.name)
      target.listTasks(group.name); team.listTasks(group.name)
      const messages = target.readLeadMail().filter((message) => message.taskId === task.id)
      assert.equal(messages.length, 1)
      assert.equal(messages[0].messageId, notification.messageId)
      assert.equal(messages[0].ts, notification.ts)
      assert.equal(messages[0].kind, status === 'cancelled' ? 'task_cancelled' : 'task_result')
      assert.equal(store.listTasks(group.name)[0].status, status)
      assert.equal(store.listTasks(group.name)[0].attempt, 1)
      assert.equal(store.listTasks(group.name)[0].notifications, undefined)
      assert.equal(models, status === 'done' ? 2 : 1)
      assert.equal(effects, status === 'done' ? 1 : 0)
      assert.equal(hooksRun, status === 'cancelled' ? 0 : 1)
      if (status === 'done') assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'EFFECT\n')
    } finally {
      appendBlocked = false; ackBlocked = false; postAppendBlocked = false; partialBlocked = false; noNewlineBlocked = false; readBlocked = false
      fs.appendFileSync = originalAppend; fs.renameSync = originalRename; fs.statSync = originalStat; syncBuiltinESMExports(); gate.resolve()
      await team.close(1000); await Promise.allSettled([execution]); await fresh?.close(1000); await f.close()
    }
  })
}

await check('重试过程中保留前次未发通知，恢复后按原顺序补发且去重', async () => {
  let models = 0, blocked = true
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    if (++models === 1) throw new Error('RETRY-ME')
    yield { type: 'text', text: 'RETRY-COMPLETED' }; yield { type: 'done' }
  } }
  const f = await streamFixture(provider)
  const teamRoot = join(f.root, 'team'), store = new TeamGroupStore(teamRoot)
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx: f.chat.getToolContext() })
  const original = fs.appendFileSync
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'RETRY-NOTIFICATIONS', undefined, [], 2)
    fs.appendFileSync = ((file, data, options) => {
      if (blocked && String(file).startsWith(join(teamRoot, '_shared', 'mail'))) throw Object.assign(new Error('MAIL-EIO'), { code: 'EIO' })
      return original(file, data, options)
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    await bounded(team.runTask(group, task, 'alice'))
    await waitUntil(() => store.listTasks(group.name)[0].status === 'done')
    assert.equal(models, 2)
    const messages = store.listTasks(group.name)[0].notifications!
    assert.equal(messages.length, 2)
    assert.notEqual(messages[0].messageId, messages[1].messageId)
    blocked = false
    team.listTasks(group.name); team.listTasks(group.name)
    assert.deepEqual(team.readLeadMail().filter((message) => message.taskId === task.id).map((message) => message.kind), ['task_retry', 'task_result'])
    assert.equal(store.listTasks(group.name)[0].notifications, undefined)
    assert.equal(models, 2)
  } finally { blocked = false; fs.appendFileSync = original; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})

await check('通知缓存隔离与损坏校验，非法关闭重排日志拒绝保存', async () => {
  const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
  const f = await streamFixture(provider)
  const store = new TeamGroupStore(join(f.root, 'team'))
  try {
    store.createGroup('audit', 'lead')
    const message = { messageId: 'stable-message', taskId: 'task', groupId: 'audit', correlationId: 'report', from: 'alice', to: 'lead', body: 'RESULT', kind: 'task_result', ts: 1, read: false }
    const task = { id: 'task', title: 'task', status: 'done' as const, notifications: [message] }
    store.saveTasks('audit', [task])
    store.listTasks('audit')[0].notifications![0].body = 'MUTATED'
    assert.equal(store.listTasks('audit')[0].notifications![0].body, 'RESULT')
    assert.equal(new TeamGroupStore(join(f.root, 'team')).listTasks('audit')[0].notifications![0].body, 'RESULT')
    store.saveTasks('audit', [{ ...task, notifications: [{ ...message, taskId: 'OTHER' }] }])
    assert.throws(() => store.listTasks('audit'), /任务文件损坏/)
    store.saveTasks('audit', [task])
    assert.throws(() => store.saveTaskSettlement({ kind: 'result', groupName: 'audit', taskId: 'task', memberName: 'alice', leaseId: 'lease', reportId: 'report', requeueOnShutdown: true,
      result: { status: 'done', text: 'done', report: { reportId: 'report', status: 'done', summary: 'done' } } }), /非法/)
  } finally { await f.close() }
})

console.log(`team_notification_test: ${passed} 通过，${failed} 失败`)
if (failed) process.exitCode = 1
