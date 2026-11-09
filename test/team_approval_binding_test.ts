import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { HookEngine } from '../src/hook/engine.ts'
import type { Provider } from '../src/provider/types.ts'
import { TeamGroupStore, TeamManager, TeamMail } from '../src/team/index.ts'
import { createLeadTools } from '../src/team/lead-tools.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { bounded, deferred, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: () => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  try { await test(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
}
async function waitUntil(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= end) throw new Error('审批身份验证超时')
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function fixture(stage: 'approval' | 'start' | 'model' = 'approval') {
  const started = deferred(), gate = deferred(), hooks = new HookEngine([])
  if (stage !== 'start' && stage !== 'model') gate.resolve()
  let models = 0, effects = 0
  hooks.fire = async (event, _payload, signal) => {
    if (stage === 'start' && event === 'subagent_start') { started.resolve(); await resolveOnAbort(gate.promise, signal, undefined) }
  }
  const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
    models++
    if (stage === 'model') { started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined); if (options.signal?.aborted) return }
    if (messages.at(-1)?.role !== 'tool') yield { type: 'tool_call', id: 'approved-write-' + models, name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'REAL-APPROVED-DONE' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider, { hooks }), teamRoot = join(f.root, 'team'), peer = new TeamGroupStore(teamRoot), mail = new TeamMail(join(teamRoot, '_shared', 'mail'))
  const ctx = { ...f.chat.getToolContext(), agentId: 'lead-agent' }
  const team = new TeamManager(teamRoot, f.root, { provider, registry: f.registry, ctx })
  const group = team.createGroup('audit', 'lead'), host = await team.spawnMember(group, 'alice', 'worker', { agentId: 'alice-agent', needsApproval: true, roleDefinition: null })
  const effectsFile = join(f.root, 'effects.log')
  f.registry.register({ name: 'write_file', description: '真实审批后写入', parameters: { type: 'object' }, async execute() {
    effects++; fs.appendFileSync(effectsFile, 'APPROVED-EFFECT\n'); return { success: true, output: 'APPROVED-EFFECT' }
  } })
  const task = team.addTask('audit', 'APPROVAL-WORK', 'alice'), runs: Promise<string>[] = []
  const plans = () => mail.read('lead').filter((message) => message.kind === 'approval_plan' && message.taskId === task.id)
  const decisions = () => mail.read('alice').filter((message) => message.kind === 'approval_decision')
  return { ...f, teamRoot, peer, mail, ctx, team, group, host, task, gate, started, effectsFile, plans, decisions,
    get models() { return models }, get effects() { return effects },
    run() { const execution = team.runTask(group, task, 'alice'); runs.push(execution); return execution },
    async plan() { await waitUntil(() => plans().length > 0); return plans().at(-1)! },
    async close() { gate.resolve(); await team.close(1000); await Promise.allSettled(runs); await f.close() },
  }
}

for (const invalid of ['group', 'missing-group', 'broadcast', 'approve-prefix', 'deny-prefix'] as const) await check('审批消息 ' + invalid + ' 不得放行实际模型或工具', async () => {
  const f = await fixture()
  try {
    const execution = f.run(), plan = await f.plan()
    f.mail.send('lead', invalid === 'broadcast' ? '*' : 'alice', invalid === 'approve-prefix' ? 'APPROVED' : invalid === 'deny-prefix' ? 'DENYING' : 'APPROVE', {
      ...(invalid === 'missing-group' ? {} : { groupId: invalid === 'group' ? 'other' : 'audit' }),
      kind: 'approval_decision', taskId: f.task.id, correlationId: plan.correlationId,
    })
    await new Promise((done) => setTimeout(done, 80))
    assert.equal(f.models, 0); assert.equal(f.effects, 0); assert.equal(f.peer.listTasks('audit')[0].status, 'in_progress')
    assert.match(f.team.respondApproval('audit', 'alice', true, undefined, f.task.id, plan.correlationId), /^已批准/)
    assert.match(await bounded(execution), /REAL-APPROVED-DONE/); assert.equal(f.effects, 1)
  } finally { await f.close() }
})

for (const state of ['host-closed', 'manager-closed', 'offline', 'agent', 'duplicate', 'lease', 'expired', 'lead'] as const) await check('等待审批时 ' + state + ' 变化，拒绝旧请求且不写决策邮件', async () => {
  const f = await fixture()
  try {
    const execution = f.run(), plan = await f.plan()
    if (state === 'host-closed') f.host.close()
    if (state === 'manager-closed') await f.team.close()
    if (state === 'offline' || state === 'agent' || state === 'lead') f.peer.mutateGroup('audit', (group) => {
      if (state === 'offline') group.members[0].status = 'offline'
      if (state === 'agent') group.members[0].agentId = 'replacement-agent'
      if (state === 'lead') group.lead = 'replacement-lead'
    })
    if (state === 'duplicate') {
      const other = f.peer.createGroup('other', 'other-lead')
      f.peer.addMember(other, { ...f.group.members[0], name: 'bob' })
    }
    if (state === 'lease') f.peer.updateTask('audit', f.task.id, { leaseId: 'replacement-lease' })
    if (state === 'expired') f.peer.updateTask('audit', f.task.id, { leaseExpiresAt: Date.now() - 1 })
    assert.match(f.team.respondApproval('audit', 'alice', true, undefined, f.task.id, plan.correlationId), /^审批失败:/)
    assert.deepEqual(f.decisions(), []); assert.equal(f.models, 0); assert.equal(f.effects, 0)
    if (state === 'lead') { await bounded(execution); assert.equal(f.peer.listTasks('audit')[0].status, 'failed') }
  } finally { await f.close() }
})

await check('重试等待开始 Hook 时旧 PLAN 不能被自动批准，当前 PLAN 到达后才允许继续', async () => {
  const f = await fixture()
  try {
    const first = f.run(), oldPlan = await f.plan()
    assert.match(f.team.respondApproval('audit', 'alice', false, 'FIRST-DENIED', f.task.id, oldPlan.correlationId), /^已拒绝/)
    await bounded(first)
    f.peer.updateTask('audit', f.task.id, { status: 'todo', attempt: 0, result: undefined, report: undefined, reportId: undefined, nextRetryAt: undefined })
    const gate = deferred(), started = deferred()
    f.ctx.hooks!.fire = async (event, _payload, signal) => { if (event === 'subagent_start') { started.resolve(); await resolveOnAbort(gate.promise, signal, undefined) } }
    const second = f.run(); await bounded(started.promise)
    try {
      const before = f.decisions()
      assert.match(f.team.respondApproval('audit', 'alice', true), /^审批失败:/)
      assert.match(f.team.respondApproval('audit', 'alice', true, undefined, f.task.id, oldPlan.correlationId), /^审批失败:/)
      assert.deepEqual(f.decisions(), before)
      gate.resolve(); await waitUntil(() => f.plans().length === 2)
      const current = f.plans().at(-1)!
      assert.notEqual(current.correlationId, oldPlan.correlationId)
      assert.match(f.team.respondApproval('audit', 'alice', true, undefined, f.task.id, current.correlationId), /^已批准/)
      await bounded(second); assert.equal(f.effects, 1)
    } finally { gate.resolve() }
  } finally { await f.close() }
})

await check('审批通过后模型正在执行时不重复批准或再发拒绝', async () => {
  const f = await fixture('model')
  try {
    const execution = f.run(); await f.plan()
    assert.match(f.team.respondApproval('audit', 'alice', true), /^已批准/)
    const repeated = f.team.respondApproval('audit', 'alice', false)
    assert.match(repeated, /^审批失败:/)
    await bounded(f.started.promise); assert.match(f.team.respondApproval('audit', 'alice', true), /^审批失败:/)
    assert.equal(f.decisions().length, 1); f.gate.resolve(); await bounded(execution); assert.equal(f.effects, 1)
  } finally { await f.close() }
})

await check('自定义负责人邮箱按小组可见 PLAN，分页保留小组参数，审批后真实执行一次', async () => {
  const f = await fixture()
  try {
    f.peer.mutateGroup('audit', (group) => { group.lead = 'captain' })
    const execution = f.run()
    await waitUntil(() => f.mail.read('captain').some((message) => message.kind === 'approval_plan'))
    f.mail.send('alice', 'captain', 'LATEST-REPORT', { groupId: 'audit' })
    const tool = createLeadTools(f.team).find((tool) => tool.name === 'team_mail')!
    const page = await tool.execute({ action: 'read', group: 'audit', limit: 1 }, f.ctx)
    assert.equal(page.success, true); assert.match(page.output, /LATEST-REPORT/)
    const next = JSON.parse(page.output.split('下一页参数：')[1]); assert.equal(next.group, 'audit')
    const planPage = await tool.execute(next, f.ctx); assert.equal(planPage.success, true); assert.match(planPage.output, /PLAN/)
    assert.equal(f.team.readLeadMail(false, 'audit').length, 2); assert.deepEqual(f.team.readLeadMail(), [])
    assert.equal((await tool.execute({ group: 'missing' }, f.ctx)).success, false)
    assert.equal((await tool.execute({ group: '' }, f.ctx)).success, false)
    assert.match(f.team.respondApproval('audit', 'alice', true), /^已批准/)
    await bounded(execution); assert.equal(f.effects, 1)
  } finally { await f.close() }
})

await check('有效 DENY 明确返回完整原因，不调用模型或写文件', async () => {
  const f = await fixture()
  try {
    const execution = f.run(); await f.plan()
    assert.match(f.team.respondApproval('audit', 'alice', false, '原因完整保留'), /^已拒绝/)
    assert.match(await bounded(execution), /原因完整保留/); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally { await f.close() }
})

await check('决策写入失败返回审批失败，当前请求仍可重试且只执行一次', async () => {
  const f = await fixture(), append = fs.appendFileSync
  try {
    const execution = f.run(); await f.plan()
    fs.appendFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(path) === join(f.teamRoot, '_shared', 'mail', 'alice.mail')) throw Object.assign(new Error('APPROVAL-MAIL-EIO'), { code: 'EIO' })
      return Reflect.apply(append, fs, [path, ...args])
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    assert.match(f.team.respondApproval('audit', 'alice', true), /^审批失败:.*APPROVAL-MAIL-EIO/)
    assert.deepEqual(f.decisions(), []); assert.equal(f.models, 0)
    fs.appendFileSync = append; syncBuiltinESMExports()
    assert.match(f.team.respondApproval('audit', 'alice', true), /^已批准/)
    await bounded(execution); assert.equal(f.effects, 1); assert.equal(f.decisions().length, 1)
  } finally { fs.appendFileSync = append; syncBuiltinESMExports(); await f.close() }
})

await check('直接决策到达时任务租约已改变，不调用模型且不覆盖新租约', async () => {
  const f = await fixture()
  try {
    const execution = f.run(), plan = await f.plan()
    f.peer.updateTask('audit', f.task.id, { leaseId: 'replacement-lease' })
    f.mail.send('lead', 'alice', 'APPROVE', { groupId: 'audit', kind: 'approval_decision', taskId: f.task.id, correlationId: plan.correlationId })
    await bounded(execution); assert.equal(f.models, 0); assert.equal(f.effects, 0)
    assert.equal(f.peer.listTasks('audit')[0].leaseId, 'replacement-lease'); assert.equal(f.peer.listTasks('audit')[0].status, 'in_progress')
  } finally { await f.close() }
})

for (const recovered of ['valid', 'lease'] as const) await check('收到审批后任务文件暂时读不到，恢复为 ' + recovered + ' 时按当前租约处理', async () => {
  const f = await fixture(), stat = fs.statSync, file = join(f.teamRoot, 'audit', 'tasks.json')
  let blocked = false, reads = 0
  try {
    const execution = f.run(), plan = await f.plan()
    fs.statSync = ((path, options) => {
      if (blocked && String(path) === file) { reads++; throw Object.assign(new Error('APPROVAL-TASK-EIO'), { code: 'EIO' }) }
      return stat(path, options)
    }) as typeof fs.statSync
    syncBuiltinESMExports(); blocked = true
    f.mail.send('lead', 'alice', 'APPROVE', { groupId: 'audit', kind: 'approval_decision', taskId: f.task.id, correlationId: plan.correlationId })
    await waitUntil(() => reads >= 2); assert.equal(f.models, 0); assert.equal(f.effects, 0)
    blocked = false; if (recovered === 'lease') f.peer.updateTask('audit', f.task.id, { leaseId: 'replacement-lease' })
    await bounded(execution); assert.equal(f.effects, recovered === 'valid' ? 1 : 0)
    assert.equal(f.peer.listTasks('audit')[0].status, recovered === 'valid' ? 'done' : 'in_progress')
  } finally { blocked = false; fs.statSync = stat; syncBuiltinESMExports(); await f.close() }
})

for (const changed of ['member', 'lease'] as const) await check('真实进程在审批等待锁期间替换 ' + changed + '，提交时拒绝旧关联', async () => {
  const f = await fixture(), ready = join(f.root, 'peer-ready'), result = join(f.root, 'peer-result')
  let child: ChildProcess | undefined, exited: Promise<void> | undefined
  try {
    f.run(); const plan = await f.plan()
    const worker = `
      import fs from 'node:fs'
      import { join } from 'node:path'
      import { syncBuiltinESMExports } from 'node:module'
      import { TeamGroupStore } from ${JSON.stringify(new URL('../src/team/group.ts', import.meta.url).href)}
      import { withFileLock } from ${JSON.stringify(new URL('../src/runtime/file-lock.ts', import.meta.url).href)}
      const [root, ready, result, changed, taskId] = process.argv.slice(1), store = new TeamGroupStore(root), rename = fs.renameSync
      const memberLock = join(root, '_shared', 'members.lock'), taskLock = join(root, 'audit', 'tasks.lock')
      let paused = false, waiting = ''
      const file = join(root, 'audit', changed === 'member' ? 'group.yaml' : 'tasks.json')
      fs.renameSync = (source, destination) => {
        if (paused || String(destination) !== file) return rename(source, destination)
        paused = true
        const commit = () => {
          fs.writeFileSync(ready, 'locked')
          const sleep = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 4000
          while (!fs.existsSync(memberLock + '.queue') && !fs.existsSync(taskLock + '.queue')) {
            if (Date.now() >= end) break
            Atomics.wait(sleep, 0, 0, 2)
          }
          waiting = fs.existsSync(memberLock + '.queue') ? 'member' : fs.existsSync(taskLock + '.queue') ? 'task' : 'none'
          return rename(source, destination)
        }
        return changed === 'member' ? withFileLock(taskLock, commit) : commit()
      }
      syncBuiltinESMExports()
      try {
        if (changed === 'member') store.mutateGroup('audit', (group) => { group.members[0].agentId = 'replacement-agent' })
        else store.updateTask('audit', taskId, { leaseId: 'replacement-lease' })
      } finally { fs.renameSync = rename; syncBuiltinESMExports() }
      fs.writeFileSync(result, waiting)
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, f.teamRoot, ready, result, changed, f.task.id], { cwd: join(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || '审批进程退出 ' + code))) }); void exited.catch(() => {})
    await waitUntil(() => fs.existsSync(ready))
    assert.match(f.team.respondApproval('audit', 'alice', true, undefined, f.task.id, plan.correlationId), /^审批失败:/)
    await bounded(exited); assert.equal(fs.readFileSync(result, 'utf8'), changed === 'member' ? 'member' : 'task')
    assert.deepEqual(f.decisions(), []); assert.equal(f.models, 0); assert.equal(f.effects, 0)
  } finally {
    if (exited && child && child.exitCode === null && child.signalCode === null) await exited.catch(() => {})
    await Promise.allSettled(exited ? [exited] : []); await f.close()
  }
})

console.log(`\n审批身份绑定: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
