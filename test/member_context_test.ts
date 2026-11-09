import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { estimateMessageTokens } from '../src/context/estimate.ts'
import { SUMMARY_SYSTEM } from '../src/context/summary.ts'
import { HookEngine } from '../src/hook/engine.ts'
import { RuleEngine } from '../src/permission/rules.ts'
import type { ChatMessage, Provider, StreamChatOptions, StreamEvent } from '../src/provider/types.ts'
import { createAgentRuntimeContext } from '../src/runtime/agent-context.ts'
import { History } from '../src/session/history.ts'
import { projectStatePath } from '../src/state-paths.ts'
import { TeamManager } from '../src/team/index.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolContext } from '../src/tools/types.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('成员请求未及时结束')), 2000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function messages(name: string, count = 20, chars = 200): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${name}:${index}:` + 'x'.repeat(chars - `${name}:${index}:`.length),
  }))
}

class MemberProvider implements Provider {
  readonly protocol = 'openai' as const
  summaries: ChatMessage[][] = []
  requests: Array<{ task: string; round: number; messages: ChatMessage[] }> = []
  summarySignals: Array<AbortSignal | undefined> = []
  onMain: ((task: string, round: number, messages: ChatMessage[]) => StreamEvent[] | Promise<StreamEvent[]>) | undefined
  onSummary: ((options: StreamChatOptions) => Promise<void>) | undefined
  private rounds = new Map<string, number>()

  async *streamChat(messages: ChatMessage[], options: StreamChatOptions): AsyncGenerator<StreamEvent> {
    if (messages[0]?.content === SUMMARY_SYSTEM) {
      this.summaries.push(messages)
      this.summarySignals.push(options.signal)
      await this.onSummary?.(options)
      yield { type: 'text', text: '本地成员摘要' }
    } else {
      const task = messages.findLast((message) => message.role === 'user' && message.content.startsWith('TASK_'))?.content ?? ''
      const round = (this.rounds.get(task) ?? 0) + 1
      this.rounds.set(task, round)
      this.requests.push({ task, round, messages })
      const events = this.onMain ? await this.onMain(task, round, messages) : [
        { type: 'usage' as const, inputTokens: 7777, outputTokens: 1 },
        { type: 'text' as const, text: '成员完成' },
      ]
      for (const event of events) yield event
    }
    yield { type: 'done' }
  }
}

async function fixture(test: (value: {
  root: string; leadDir: string; lead: History; ctx: ToolContext; provider: MemberProvider;
  manager: TeamManager; probes: ToolContext[]; spawn(name: string): ReturnType<TeamManager['spawnMember']>;
}) => Promise<void>, options: { configuredWindow?: number; omitParentBudget?: boolean } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'meicode-member-context-'))
  const leadDir = join(root, 'lead')
  mkdirSync(leadDir)
  const lead = new History()
  for (const message of messages('LEAD')) lead.push(message)
  const provider = new MemberProvider()
  const ctx = createAgentRuntimeContext({ provider, history: lead, cwd: leadDir, contextWindow: 8192, sessionId: 'old-session', agentId: 'lead-agent', permissionMode: 'permissive', engine: new RuleEngine('unused-user', 'unused-project', 'unused-local') })
  if (options.omitParentBudget) delete ctx.contextBudget
  const probes: ToolContext[] = []
  const registry = new ToolRegistry()
  registry.register({
    name: 'team_task', description: '本地预算探针', parameters: { type: 'object' },
    async execute(args, context) {
      probes.push(context)
      return { success: true, output: args.large ? 'z'.repeat(62000) : 'OK' }
    },
  })
  const manager = new TeamManager(join(root, 'team'), leadDir, { provider, registry, ctx, contextWindow: options.configuredWindow })
  const group = manager.createGroup('isolation', 'lead')
  const spawn = (name: string) => {
    const workdir = join(root, name)
    mkdirSync(workdir, { recursive: true })
    return manager.spawnMember(group, name, 'worker', { workdir, agentId: `agent-${name}`, roleDefinition: null })
  }
  try {
    await test({ root, leadDir, lead, ctx, provider, manager, probes, spawn })
  } finally {
    await manager.close()
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert(basename(root).startsWith('meicode-member-context-'))
    assert(!lstatSync(root).isSymbolicLink())
    rmSync(root, { recursive: true, force: true })
  }
}

await check('成员7777输入tokens不修改主会话1000tokens预算或触发主会话摘要', () => fixture(async ({ lead, ctx, provider, spawn }) => {
  const original = lead.all()
  const before = ctx.contextBudget!()
  const alice = await spawn('alice')
  assert.equal((await alice.execute('TASK_alice', 'alice-task')).status, 'done')
  assert.deepEqual(ctx.contextBudget!(), before)
  assert.deepEqual(lead.view(), original)
  assert.equal((await ctx.beforeRequest!('auto'))?.status, 'skipped')
  assert.equal(provider.summaries.length, 0)
}))

await check('并行成员的usage锚点互不覆盖，继承权限与身份且各自使用8K窗口', () => fixture(async ({ ctx, provider, probes, spawn }) => {
  const alice = await spawn('alice')
  const bob = await spawn('bob')
  const before = ctx.contextBudget!()
  provider.onMain = (task, round) => round === 1 ? [
    { type: 'usage', inputTokens: task === 'TASK_alice' ? 3333 : 4444, outputTokens: 1 },
    { type: 'tool_call', id: `${task}-probe`, name: 'team_task', arguments: {} },
  ] : [{ type: 'text', text: '成员完成' }]
  assert((await Promise.all([alice.execute('TASK_alice', 'alice-task'), bob.execute('TASK_bob', 'bob-task')])).every((result) => result.status === 'done'))
  assert.equal(probes.length, 2)
  const byAgent = new Map(probes.map((probe) => [probe.agentId, probe]))
  assert.equal(byAgent.get('agent-alice')!.contextBudget!().lastInputTokens, 3333)
  assert.equal(byAgent.get('agent-bob')!.contextBudget!().lastInputTokens, 4444)
  for (const probe of probes) {
    assert.equal(probe.contextBudget!().window, 8192)
    assert.equal(probe.permission, ctx.permission)
    assert.notEqual(probe.contextBudget, ctx.contextBudget)
    assert.notEqual(probe.beforeRequest, ctx.beforeRequest)
  }
  assert.deepEqual(ctx.contextBudget!(), before)
}))

await check('成员历史超过8K自动阈值只摘要自己，并将压缩历史正确持久化', () => fixture(async ({ root, lead, ctx, provider, spawn }) => {
  const original = lead.all()
  const before = ctx.contextBudget!()
  const alice = await spawn('alice')
  for (const message of messages('ALICE', 20, 1800)) alice.history.push(message)
  assert.equal((await alice.execute('TASK_alice', 'alice-task')).status, 'done')
  assert.equal(provider.summaries.length, 1)
  assert(provider.summaries[0].some((message) => message.content.startsWith('ALICE:')))
  assert(!provider.summaries[0].some((message) => message.content.startsWith('LEAD:')))
  assert.match(alice.history.view()[0].content, /早期对话摘要/)
  assert.deepEqual(lead.view(), original)
  assert.deepEqual(ctx.contextBudget!(), before)
  const file = join(root, 'team', 'isolation', 'members', 'alice.history.jsonl')
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), alice.history.view())
}))

await check('长任务每轮检查自己的usage，第二轮前压缩并保留工具配对', () => fixture(async ({ lead, ctx, provider, spawn }) => {
  const before = ctx.contextBudget!()
  const original = lead.all()
  const alice = await spawn('alice')
  for (const message of messages('ALICE', 20, 1100)) alice.history.push(message)
  provider.onMain = (_, round) => round === 1 ? [
    { type: 'usage', inputTokens: 7400, outputTokens: 1 },
    { type: 'tool_call', id: 'local-probe', name: 'team_task', arguments: {} },
  ] : [{ type: 'text', text: '成员完成' }]
  assert.equal((await alice.execute('TASK_alice', 'alice-task')).status, 'done')
  assert.equal(provider.requests.length, 2)
  assert.equal(provider.summaries.length, 1)
  const sent = provider.requests[1].messages
  const index = sent.findIndex((message) => message.tool_calls?.[0]?.id === 'local-probe')
  assert(index >= 0)
  assert.equal(sent[index + 1].tool_call_id, 'local-probe')
  assert.deepEqual(ctx.contextBudget!(), before)
  assert.deepEqual(lead.view(), original)
}))

await check('最后一轮成员超限强制压缩自己的历史，主会话保持完整', () => fixture(async ({ root, lead, ctx, provider, manager }) => {
  const original = lead.all()
  const before = ctx.contextBudget!()
  const group = manager.loadGroup('isolation')!
  const workdir = join(root, 'alice')
  mkdirSync(workdir)
  const alice = await manager.spawnMember(group, 'alice', 'worker', { workdir, roleDefinition: { name: 'worker', description: '', content: 'r'.repeat(12000), maxRounds: 1, source: 'builtin' } })
  for (const message of messages('ALICE', 20, 600)) alice.history.push(message)
  provider.onMain = (_, __, history) => history.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + 3000 > 8192
    ? [{ type: 'error', message: 'maximum context length exceeded' }]
    : [{ type: 'text', text: '成员恢复成功' }]
  const result = await alice.execute('TASK_alice', 'alice-task')
  assert.equal(result.status, 'done')
  assert.equal(result.text, '成员恢复成功')
  assert.equal(provider.requests.length, 2)
  assert.equal(provider.summaries.length, 1)
  assert(provider.summaries[0].some((message) => message.content.startsWith('ALICE:')))
  assert.deepEqual(lead.view(), original)
  assert.deepEqual(ctx.contextBudget!(), before)
}))

await check('成员的大工具结果存到自己的工作目录，父spill回调不被调用', () => fixture(async ({ root, leadDir, ctx, provider, spawn }) => {
  let parentSpills = 0
  ctx.spill = async (results) => { parentSpills++; return results }
  const before = ctx.contextBudget!()
  const alice = await spawn('alice')
  provider.onMain = (_, round) => round === 1 ? [
    { type: 'usage', inputTokens: 2000, outputTokens: 1 },
    { type: 'tool_call', id: 'large-probe', name: 'team_task', arguments: { large: true } },
  ] : [{ type: 'text', text: '成员完成' }]
  assert.equal((await alice.execute('TASK_alice', 'alice-task')).status, 'done')
  const result = provider.requests[1].messages.find((message) => message.tool_call_id === 'large-probe')!
  assert.match(result.content, /\[已存盘\]/)
  const workdir = join(root, 'alice')
  const file = resolve(workdir, result.content.split('完整内容: ')[1])
  assert(file.startsWith(resolve(workdir) + sep))
  assert.equal(readFileSync(file, 'utf8'), 'z'.repeat(62000))
  assert.equal(parentSpills, 0)
  assert(!readdirSync(projectStatePath(leadDir, 'artifacts')).some((name) => name.startsWith('spill_')))
  assert.deepEqual(ctx.contextBudget!(), before)
}))

await check('取消成员摘要不影响其他成员或父预算，迟到摘要不会覆盖历史', () => fixture(async ({ ctx, provider, spawn }) => {
  const before = ctx.contextBudget!()
  const alice = await spawn('alice')
  const bob = await spawn('bob')
  for (const message of messages('ALICE', 20, 1800)) alice.history.push(message)
  const original = alice.history.all()
  const waiting = deferred()
  const gate = deferred()
  const finished = deferred()
  provider.onSummary = async () => {
    waiting.resolve()
    await gate.promise
    finished.resolve()
  }
  const execution = alice.execute('TASK_alice', 'alice-task')
  try {
    await bounded(waiting.promise)
    assert(alice.cancel('alice-task'))
    assert.equal((await bounded(execution)).status, 'failed')
    assert(provider.summarySignals[0]?.aborted)
    assert(!provider.requests.some((request) => request.task === 'TASK_alice'))
    assert.equal((await bob.execute('TASK_bob', 'bob-task')).status, 'done')
    const cancelledHistory = alice.history.all()
    assert.deepEqual(cancelledHistory.slice(0, original.length), original)
    gate.resolve()
    await bounded(finished.promise)
    assert.deepEqual(alice.history.view(), cancelledHistory)
    assert.deepEqual(ctx.contextBudget!(), before)
  } finally {
    alice.cancel('alice-task')
    gate.resolve()
    await bounded(execution)
  }
}))

await check('执行中会话切换延迟到任务结束，之后重置锚点并使用新的压缩Hook作用域', () => fixture(async ({ root, ctx, provider, manager, probes, spawn }) => {
  const records: Array<{ event: string; sessionId?: string; agentId?: string; cwd: string }> = []
  const hooks = new HookEngine([])
  hooks.fire = async (event, payload) => { records.push({ event, sessionId: payload.sessionId, agentId: payload.agentId, cwd: payload.cwd }) }
  ctx.hooks = hooks
  const alice = await spawn('alice')
  for (const message of messages('ALICE', 20, 1800)) alice.history.push(message)
  const waiting = deferred()
  const gate = deferred()
  provider.onSummary = async () => { waiting.resolve(); await gate.promise }
  provider.onMain = (task, round) => task === 'TASK_alice_old' && round === 1 ? [
    { type: 'usage', inputTokens: 2000, outputTokens: 1 },
    { type: 'tool_call', id: 'scope-probe', name: 'team_task', arguments: {} },
  ] : [{ type: 'text', text: '成员完成' }]
  const execution = alice.execute('TASK_alice_old', 'alice-old')
  try {
    await bounded(waiting.promise)
    manager.setSessionId('new-session')
    assert(!provider.summarySignals[0]?.aborted)
    gate.resolve()
    assert.equal((await bounded(execution)).status, 'done')
  } finally {
    gate.resolve()
    await bounded(execution)
  }
  assert.equal(probes[0].sessionId, 'old-session')
  assert.equal(probes[0].contextBudget!().lastInputTokens, undefined)
  assert.equal(probes[0].contextBudget!().breakerOpen, false)
  assert(records.some((record) => record.event === 'post_compact' && record.sessionId === 'old-session'))
  alice.history.replaceRange(0, alice.history.length, messages('ALICE', 20, 1800))
  assert.equal((await alice.execute('TASK_alice_new', 'alice-new')).status, 'done')
  assert.equal(provider.summaries.length, 2)
  for (const event of ['pre_compact', 'post_compact']) {
    assert(records.some((record) => record.event === event && record.sessionId === 'new-session' && record.agentId === 'agent-alice' && record.cwd === join(root, 'alice')))
  }
}))

await check('成员摘要失败的熔断独立，其他成员和主会话仍可正常压缩', () => fixture(async ({ ctx, provider, probes, spawn }) => {
  const before = ctx.contextBudget!()
  const alice = await spawn('alice')
  const bob = await spawn('bob')
  for (const message of messages('ALICE', 20, 1800)) alice.history.push(message)
  for (const message of messages('BOB', 20, 1800)) bob.history.push(message)
  provider.onSummary = async () => {
    if (provider.summaries.at(-1)!.some((message) => message.content.startsWith('ALICE:'))) throw new Error('仅Alice摘要失败')
  }
  provider.onMain = (task, round) => round === 1 ? [
    { type: 'tool_call', id: `${task}-probe`, name: 'team_task', arguments: {} },
  ] : [{ type: 'text', text: '成员完成' }]
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await alice.execute(`TASK_alice_${attempt}`, `alice-${attempt}`)).status, 'done')
  assert(probes.filter((probe) => probe.agentId === 'agent-alice').every((probe) => probe.contextBudget!().breakerOpen))
  assert.equal((await bob.execute('TASK_bob', 'bob-task')).status, 'done')
  assert.equal(probes.find((probe) => probe.agentId === 'agent-bob')!.contextBudget!().breakerOpen, false)
  assert(provider.summaries.some((summary) => summary.some((message) => message.content.startsWith('BOB:'))))
  assert.deepEqual(ctx.contextBudget!(), before)
}))

await check('父上下文没有budget回调时，成员恢复历史仍遵循明确配置的8K窗口', () => fixture(async ({ root, provider, spawn }) => {
  const file = join(root, 'team', 'isolation', 'members', 'alice.history.jsonl')
  writeFileSync(file, messages('RESTORED', 20, 1800).map((message) => JSON.stringify(message)).join('\n') + '\n')
  const alice = await spawn('alice')
  assert.equal((await alice.execute('TASK_alice', 'alice-task')).status, 'done')
  assert.equal(provider.summaries.length, 1)
  assert(provider.summaries[0].some((message) => message.content.startsWith('RESTORED:')))
  assert.match(alice.history.view()[0].content, /早期对话摘要/)
}, { configuredWindow: 8192, omitParentBudget: true }))

console.log(`\nmember_context_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
