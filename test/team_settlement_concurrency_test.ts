import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore } from '../src/team/group.ts'
import { TeamManager } from '../src/team/index.ts'
import type { TeamTaskSettlement } from '../src/team/types.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}

const provider: Provider = { protocol: 'openai', async *streamChat() { yield { type: 'done' } } }
const entry = (reportId: string, agentId = 'old-agent'): TeamTaskSettlement => ({
  kind: 'cancel', groupName: 'audit', taskId: 'task', memberName: 'alice', leaseId: 'lease', agentId, reportId,
})
function settlement(reportId: string, kind: 'running' | 'queued' | 'result', agentId = 'old-agent'): TeamTaskSettlement {
  const record = entry(reportId, agentId)
  if (kind === 'queued') { delete record.leaseId; record.queuedTask = { title: 'QUEUED', assignee: 'alice', attempt: 0, updatedAt: 1 } }
  if (kind === 'result') { record.kind = 'result'; record.result = { status: 'done', text: reportId, report: { reportId, status: 'done', summary: reportId } } }
  return record
}
function legacyFile(root: string, record: TeamTaskSettlement): string {
  const snapshot = record.queuedTask
  const identity = snapshot
    ? [record.kind, record.taskId, record.leaseId, snapshot.title, snapshot.assignee, snapshot.attempt, snapshot.updatedAt, snapshot.reportId]
    : [record.kind, record.taskId, record.leaseId]
  return join(root, record.groupName, 'tasks.pending', createHash('sha256').update(JSON.stringify(identity)).digest('hex') + '.json')
}

for (const kind of ['running', 'queued', 'result'] as const) for (const mode of ['retry', 'delete'] as const) await check('旧 ' + kind + ' 补存记录 ' + mode + ' 不覆盖或删除另一实例的新记录', async () => {
  const f = await streamFixture(provider), root = join(f.root, 'team')
  const store = new TeamGroupStore(root), peer = new TeamGroupStore(root)
  const old = settlement('old-report', kind), newer = settlement('new-report', kind, 'successor-agent')
  try {
    store.saveTaskSettlement(old)
    const stale = store.loadTaskSettlements('audit')[0]
    peer.saveTaskSettlement(newer)
    if (mode === 'retry') store.saveTaskSettlement(stale)
    else store.deleteTaskSettlement(stale)
    const remaining = peer.loadTaskSettlements('audit')
    assert(remaining.some((record) => record.reportId === newer.reportId && record.agentId === newer.agentId))
    assert.equal(remaining.length, mode === 'retry' ? 2 : 1)
    store.deleteTaskSettlement(old)
    assert.deepEqual(peer.loadTaskSettlements('audit'), [newer])
  } finally { await f.close() }
})

await check('同一补存记录重复保存、读取和清理保持幂等', async () => {
  const f = await streamFixture(provider), store = new TeamGroupStore(join(f.root, 'team'))
  try {
    const record = entry('same-report')
    for (let index = 0; index < 4; index++) store.saveTaskSettlement(structuredClone(record))
    assert.deepEqual(store.loadTaskSettlements('audit'), [record])
    store.deleteTaskSettlement(record); store.deleteTaskSettlement(record)
    assert.deepEqual(store.loadTaskSettlements('audit'), [])
  } finally { await f.close() }
})

for (const mode of ['running', 'queued', 'result'] as const) await check('旧版 ' + mode + ' 补存文件恢复并清理新旧副本', async () => {
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  try {
    const record = settlement('legacy-report', mode)
    const file = legacyFile(root, record)
    fs.mkdirSync(join(root, 'audit', 'tasks.pending'), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record))
    assert.deepEqual(store.loadTaskSettlements('audit'), [JSON.parse(JSON.stringify(record))])
    store.saveTaskSettlement(record)
    assert.equal(store.loadTaskSettlements('audit').length, 1)
    store.deleteTaskSettlement(record)
    assert.deepEqual(store.loadTaskSettlements('audit'), [])
    assert(!fs.existsSync(file))
  } finally { await f.close() }
})

await check('清理旧版快照时保留已被其他实例替换的文件', async () => {
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  try {
    const old = entry('old-report'), newer = entry('new-report', 'successor-agent'), file = legacyFile(root, old)
    fs.mkdirSync(join(root, 'audit', 'tasks.pending'), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(old))
    const stale = store.loadTaskSettlements('audit')[0]
    fs.writeFileSync(file, JSON.stringify(newer))
    store.deleteTaskSettlement(stale)
    assert.deepEqual(store.loadTaskSettlements('audit'), [newer])
  } finally { await f.close() }
})

for (const mode of ['delete', 'quarantine'] as const) await check('真实进程保存与 ' + mode + ' 交错后保留有效补存记录', async () => {
  const f = await streamFixture(provider), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const record = entry('shared-report'), replacement = { ...record, sessionId: 'new-session' }
  const directory = join(root, 'audit', 'tasks.pending'), ready = join(f.root, 'ready'), gate = join(f.root, 'gate'), done = join(f.root, 'done')
  const originalRename = fs.renameSync, originalUnlink = fs.unlinkSync
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  try {
    store.saveTaskSettlement(record)
    const file = join(directory, fs.readdirSync(directory).find((name) => name.endsWith('.json'))!)
    if (mode === 'quarantine') fs.writeFileSync(file, '{')
    const worker = `
      import { existsSync, writeFileSync } from 'node:fs'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      const [root, raw, ready, gate, done] = process.argv.slice(1)
      writeFileSync(ready, 'ready')
      const wait = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 5000
      while (!existsSync(gate)) {
        if (Date.now() >= end) throw new Error('补存交错启动超时')
        Atomics.wait(wait, 0, 0, 2)
      }
      new TeamGroupStore(root).saveTaskSettlement(JSON.parse(raw))
      writeFileSync(done, 'done')
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, root, JSON.stringify(replacement), ready, gate, done], {
      cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`补存子进程失败 (${code}): ${stderr}`)))
    })
    void exited.catch(() => {})
    timer = setTimeout(() => child?.kill(), 8000)
    const deadline = Date.now() + 3000
    while (!fs.existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error('补存子进程启动超时')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    let interleaved = false
    const interleave = () => {
      if (interleaved) return
      interleaved = true; fs.writeFileSync(gate, 'go')
      const queue = join(directory, 'settlements.lock.queue'), end = Date.now() + 3000, wait = new Int32Array(new SharedArrayBuffer(4))
      while (!fs.existsSync(done) && !fs.existsSync(queue)) {
        if (Date.now() >= end) throw new Error('补存进程交错超时')
        Atomics.wait(wait, 0, 0, 2)
      }
    }
    fs.renameSync = ((source, destination) => {
      if (mode === 'quarantine' && String(source) === file) interleave()
      return originalRename(source, destination)
    }) as typeof fs.renameSync
    fs.unlinkSync = ((path) => {
      if (mode === 'delete' && String(path) === file) interleave()
      return originalUnlink(path)
    }) as typeof fs.unlinkSync
    syncBuiltinESMExports()
    if (mode === 'delete') store.deleteTaskSettlement(record)
    else assert.deepEqual(store.loadTaskSettlements('audit'), [])
    assert(interleaved)
    await bounded(exited)
    assert.deepEqual(store.loadTaskSettlements('audit'), [replacement])
    if (mode === 'quarantine') {
      const isolated = fs.readdirSync(directory).filter((name) => name.includes('.corrupt.'))
      assert.equal(isolated.length, 1)
      assert.equal(fs.readFileSync(join(directory, isolated[0]), 'utf8'), '{')
    }
    assert(!fs.existsSync(join(directory, 'settlements.lock')))
    assert(!fs.existsSync(join(directory, 'settlements.lock.queue')))
  } finally {
    fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; syncBuiltinESMExports()
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await exited?.catch(() => {}); await f.close()
  }
})

await check('两个实例的旧新取消交错后恢复当前取消，不再次调用模型', async () => {
  const started = deferred(), gate = deferred()
  let models = 0, blocked = true
  const running: Provider = { protocol: 'openai', async *streamChat(_messages, options) {
    models++; started.resolve()
    await resolveOnAbort(gate.promise, options.signal, undefined)
    if (!options.signal?.aborted) yield { type: 'done' }
  } }
  const f = await streamFixture(running), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const options = { provider: running, registry: f.registry, ctx: f.chat.getToolContext() }
  const team = new TeamManager(root, f.root, options), peer = new TeamManager(root, f.root, options)
  const original = fs.renameSync, file = join(root, 'audit', 'tasks.json')
  let execution: Promise<string> | undefined
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'CONCURRENT-CANCEL')
    fs.renameSync = ((source, destination) => {
      if (blocked && String(destination) === file && String(source).endsWith('.tmp') && JSON.parse(fs.readFileSync(source, 'utf8')).some((record: { status: string }) => record.status === 'cancelled')) {
        throw Object.assign(new Error('CONCURRENT-CANCEL-EIO'), { code: 'EIO' })
      }
      return original(source, destination)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    execution = team.runTask(group, task, 'alice'); await bounded(started.promise)
    assert(team.cancelTask(group.name, task.id)); await bounded(execution)
    const old = store.loadTaskSettlements(group.name).find((record) => record.kind === 'cancel')!
    store.mutateTasks(group.name, (tasks) => { tasks[0].activeAgentId = 'successor-agent' })
    assert.throws(() => peer.cancelTask(group.name, task.id), /CONCURRENT-CANCEL-EIO/)
    const current = store.loadTaskSettlements(group.name).find((record) => record.agentId === 'successor-agent')!
    assert(current); assert.notEqual(current.reportId, old.reportId)
    await peer.close(0)
    blocked = false
    const final = team.listTasks(group.name)[0]
    assert.equal(final.status, 'cancelled')
    assert.equal(final.reportId, current.reportId)
    assert.equal(final.attempt, 1)
    assert.equal(models, 1)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
    const mail = team.readLeadMail().filter((message) => message.kind === 'task_cancelled')
    assert.equal(mail.length, 1); assert.equal(mail[0].correlationId, current.reportId)
  } finally {
    blocked = false; fs.renameSync = original; syncBuiltinESMExports(); gate.resolve()
    await peer.close(1000); await team.close(1000); await Promise.allSettled([execution]); await f.close()
  }
})

await check('同租约的旧新结果同时待保存时，一次恢复保存当前 Agent 的结果', async () => {
  let models = 0, blocked = false
  const running: Provider = { protocol: 'openai', async *streamChat() {
    models++; blocked = true; yield { type: 'text', text: 'OLD-RESULT' }; yield { type: 'done' }
  } }
  const f = await streamFixture(running), root = join(f.root, 'team'), store = new TeamGroupStore(root)
  const team = new TeamManager(root, f.root, { provider: running, registry: f.registry, ctx: f.chat.getToolContext() })
  const original = fs.statSync, file = join(root, 'audit', 'group.yaml')
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'alice', 'worker', { workdir: f.root, roleDefinition: null })
    const task = team.addTask(group.name, 'CONCURRENT-RESULT')
    fs.statSync = ((path, options) => {
      if (blocked && String(path) === file) throw Object.assign(new Error('CONCURRENT-RESULT-EACCES'), { code: 'EACCES' })
      return original(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports()
    assert.match(await bounded(team.runTask(group, task, 'alice')), /待保存/)
    const old = store.loadTaskSettlements(group.name).find((record) => record.kind === 'result')!
    const newer: TeamTaskSettlement = { ...old, agentId: 'successor-agent', reportId: 'successor-report', result: {
      status: 'done', text: 'SUCCESSOR-SAVED', report: { reportId: 'successor-report', status: 'done', summary: 'SUCCESSOR-SAVED' },
    } }
    store.mutateTasks(group.name, (tasks) => { tasks[0].activeAgentId = newer.agentId })
    new TeamGroupStore(root).saveTaskSettlement(newer)
    blocked = false
    const final = team.listTasks(group.name)[0]
    assert.equal(final.status, 'done'); assert.equal(final.reportId, newer.reportId)
    assert.equal(final.result, 'SUCCESSOR-SAVED'); assert.equal(final.attempt, 1)
    assert.equal(models, 1)
    assert.deepEqual(store.loadTaskSettlements(group.name), [])
    const mail = team.readLeadMail().filter((message) => message.kind === 'task_result')
    assert.equal(mail.length, 1); assert.equal(mail[0].correlationId, newer.reportId)
  } finally { blocked = false; fs.statSync = original; syncBuiltinESMExports(); await team.close(1000); await f.close() }
})

console.log(`\n团队补存并发: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
