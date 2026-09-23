// 子 Agent 系统测试：角色/过滤/spawn/后台/回流/嵌套
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SubAgentManager, SubAgentStore, createSpawnAgentTool, loadAgentRoles, parseAgentFile } from '../src/subagent/index.ts'
import { summarizeLocally } from '../src/subagent/manager.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import type { ChatMessage, Provider, StreamChatOptions, StreamEvent } from '../src/provider/types.ts'
import type { Tool } from '../src/tools/index.ts'
import type { WorktreeManager } from '../src/worktree/index.ts'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

const TMP = join(import.meta.dirname, 'fixtures_subagent')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const BUILTIN = join(TMP, 'builtin_agents')
const USER = join(TMP, 'user_agents')
const PROJECT = join(TMP, 'project_agents')
mkdirSync(BUILTIN, { recursive: true })
mkdirSync(USER, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

const shortSummary = summarizeLocally(['  alpha\n beta  ', ' gamma '])
if (shortSummary !== 'alpha beta gamma') throw new Error(`短摘要规范化错误: ${shortSummary}`)
const boundedSummary = summarizeLocally(['alpha', '---', `${'x'.repeat(1000)}🚀`], 100)
if (boundedSummary.length !== 100 || !boundedSummary.includes(' ... ') || !boundedSummary.endsWith('🚀')) throw new Error('长摘要边界截取错误')

// fake provider：主请求返回文本，摘要请求返回固定摘要
class FakeSubProvider implements Provider {
  readonly protocol = 'openai' as const
  capturedTools: unknown = null
  private reply: string
  constructor(reply = '子任务完成输出') {
    this.reply = reply
  }
  async *streamChat(messages: ChatMessage[], opts: { tools?: unknown }): AsyncGenerator<StreamEvent> {
    this.capturedTools = opts.tools ?? null
    const isSummary = messages.some((m) => m.content.includes('压缩成'))
    yield { type: 'text', text: isSummary ? '子任务摘要内容' : this.reply }
    yield { type: 'done' }
  }
}

class DeferredSubProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly started: Promise<void>
  private markStarted!: () => void
  private finishRun!: () => void
  private readonly gate: Promise<void>

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve })
    this.gate = new Promise((resolve) => { this.finishRun = resolve })
  }

  finish(): void {
    this.finishRun()
  }

  async *streamChat(): AsyncGenerator<StreamEvent> {
    this.markStarted()
    await this.gate
    yield { type: 'text', text: '旧会话后台结果' }
    yield { type: 'done' }
  }
}

class UnknownToolProvider implements Provider {
  readonly protocol = 'openai' as const

  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'tool_call', id: `missing-${Math.random()}`, name: 'missing_tool', arguments: {} }
    yield { type: 'done' }
  }
}

class AbortAwareProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly started: Promise<void>
  private markStarted!: () => void

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve })
  }

  async *streamChat(_messages: ChatMessage[], opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    this.markStarted()
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }))
    }
  }
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  createTools({ cwd: TMP }).forEach((t) => r.register(t))
  return r
}

async function main() {
  // ---------- 角色加载 ----------
  await check('角色: frontmatter 解析与坏文件跳过', () => {
    writeFileSync(
      join(BUILTIN, 'reviewer.md'),
      '---\nname: reviewer\ndescription: 审查代码\ntools_allow: [run_command, read_file]\ntools_deny: [write_file]\nmax_rounds: 5\n---\n# Reviewer\n审查任务\n',
      'utf8',
    )
    writeFileSync(join(BUILTIN, 'bad.md'), '没有 frontmatter', 'utf8')
    const roles = loadAgentRoles({ builtin: BUILTIN, user: USER, project: PROJECT })
    const r = roles.find((x) => x.name === 'reviewer')
    if (!r || r.toolsAllow?.length !== 2 || r.maxRounds !== 5) throw new Error('解析失败')
    if (r.content !== '# Reviewer\n审查任务') throw new Error('正文缺失')
    if (roles.some((x) => x.name === 'bad')) throw new Error('坏文件未跳过')
    r.toolsAllow?.push('cache-poison')
    if (loadAgentRoles({ builtin: BUILTIN, user: USER, project: PROJECT }).find((x) => x.name === 'reviewer')?.toolsAllow?.includes('cache-poison')) throw new Error('角色缓存被调用方污染')
  })
  await check('角色: 项目覆盖内置', () => {
    writeFileSync(join(PROJECT, 'reviewer.md'), '---\nname: reviewer\ndescription: 项目版\nmax_rounds: 8\n---\n项目版正文', 'utf8')
    const roles = loadAgentRoles({ builtin: BUILTIN, user: USER, project: PROJECT })
    const r = roles.find((x) => x.name === 'reviewer')
    if (!r || r.maxRounds !== 8 || r.source !== 'project') throw new Error(`覆盖失败: ${JSON.stringify(r)}`)
    writeFileSync(join(PROJECT, 'reviewer.md'), '---\nname: reviewer\ndescription: 项目版\nmax_rounds: 9\n---\n项目版正文', 'utf8')
    if (loadAgentRoles({ builtin: BUILTIN, user: USER, project: PROJECT }).find((x) => x.name === 'reviewer')?.maxRounds !== 9) throw new Error('同尺寸角色修改未使缓存失效')
  })
  writeFileSync(join(PROJECT, 'isolated.md'), '---\nname: isolated\ndescription: 隔离任务\nisolation: worktree\n---\n隔离执行', 'utf8')

  // ---------- 工具过滤 ----------
  await check('过滤: 白名单/黑名单/嵌套移除/系统工具', () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    const role = {
      name: 't',
      description: 't',
      toolsAllow: ['run_command', 'read_file'],
      toolsDeny: ['write_file'],
      content: 'x',
      source: 'builtin' as const,
    }
    const tools = manager.filterTools(role)
    // 白名单 + 系统工具（无 spawn_agent——嵌套默认禁）
    if (!tools.includes('run_command') || !tools.includes('read_file')) throw new Error('白名单缺失')
    if (tools.includes('write_file')) throw new Error('黑名单未生效')
    if (tools.includes('spawn_agent')) throw new Error('嵌套未禁用')
    if (!tools.includes('load_skill')) throw new Error('系统工具缺失')
    // fork（无角色）：父工具集去 spawn_agent
    const parentTools: Tool[] = makeRegistry().list()
    const forkTools = manager.filterTools(undefined, parentTools)
    if (forkTools.includes('spawn_agent')) throw new Error('fork 嵌套未禁用')
  })

  // ---------- spawn ----------
  await check('spawn defined: 同步返回结果 + 记录', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const provider = new FakeSubProvider()
    const registry = makeRegistry()
    const startedAt = Date.now()
    let onResultCalled = false
    manager.setOnResult(() => {
      onResultCalled = true
    })
    const res = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: '审查 src/index.ts' },
      { provider, registry, ctx: { cwd: TMP } },
    )
    if (res.async) throw new Error('同步应返回结果')
    if (!res.syncResult) throw new Error('无结果')
    if (Date.now() - startedAt > 5000) throw new Error('快速完成的同步子 Agent 被超时定时器拖住')
    if (!onResultCalled) throw new Error('onResult 未回调')
    const records = manager.listRecords()
    if (records.length !== 1 || records[0].status !== 'done') throw new Error('记录状态不符')
    records[0].status = 'error'
    const fetched = manager.getRecord(res.id)
    if (fetched?.status !== 'done') throw new Error('记录列表泄露内部可变对象')
    if (fetched) fetched.result = 'caller mutation'
    if (manager.getRecord(res.id)?.result === 'caller mutation') throw new Error('单条记录泄露内部可变对象')
    await manager.close()
    const closed = await manager.spawn({ type: 'defined', role: 'reviewer', prompt: 'closed' }, { provider, registry, ctx: { cwd: TMP } })
    if (!manager.isClosed() || !closed.syncResult?.includes('已关闭')) throw new Error('SubAgentManager close 未阻止新任务')
  })
  await check('spawn: 结果回调异常不污染任务状态', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    manager.setOnResult(() => {
      throw new Error('callback failed')
    })
    const result = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: 'callback isolation' },
      { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    const record = manager.getRecord(result.id)
    if (result.async || !result.syncResult || record?.status !== 'done') throw new Error(`回调异常污染了任务: ${record?.status}`)
  })
  await check('spawn: 异步结果回调拒绝被隔离', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    manager.setOnResult(async () => {
      throw new Error('async callback failed')
    })
    const result = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: 'async callback isolation' },
      { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (manager.getRecord(result.id)?.status !== 'done') throw new Error('异步回调拒绝污染了任务状态')
  })
  await check('spawn: async 立即后台', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const res = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: 'x', async: true },
      { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    if (!res.async || !res.id) throw new Error('未后台')
    await new Promise((r) => setTimeout(r, 300))
    const record = manager.getRecord(res.id)
    if (!record || record.status !== 'done') throw new Error('后台未完成')
  })
  await check('会话切换: 活动子任务继续写回原会话仓且当前列表隔离', async () => {
    const storeRoot = join(TMP, 'session-routing')
    const oldStore = new SubAgentStore(storeRoot, 'session-old')
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT }, null, oldStore)
    manager.loadRoles()
    const deferred = new DeferredSubProvider()
    const results: string[] = []
    manager.setOnResult((record) => { results.push(`${record.sessionId}:${record.result}`) })
    const oldRun = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: '旧会话任务', async: true },
      { provider: deferred, registry: makeRegistry(), ctx: { cwd: TMP, sessionId: 'session-old' } },
    )
    await deferred.started
    manager.setSession('session-new')
    if (manager.getSessionId() !== 'session-new') throw new Error('子 Agent 管理器未切换当前会话')
    const newRun = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: '新会话任务' },
      { provider: new FakeSubProvider('新会话结果'), registry: makeRegistry(), ctx: { cwd: TMP, sessionId: 'session-new' } },
    )
    deferred.finish()
    await manager.waitFor(oldRun.id)
    const oldRecords = new SubAgentStore(storeRoot, 'session-old').load()
    const newRecords = new SubAgentStore(storeRoot, 'session-new').load()
    if (!oldRecords.some((record) => record.id === oldRun.id && record.status === 'done') || oldRecords.some((record) => record.id === newRun.id)) {
      throw new Error('旧会话子任务未写回原会话仓')
    }
    if (!newRecords.some((record) => record.id === newRun.id && record.status === 'done') || newRecords.some((record) => record.id === oldRun.id)) {
      throw new Error('新会话子任务仓混入旧会话记录')
    }
    if (manager.listRecords().some((record) => record.id === oldRun.id) || !results.some((result) => result.startsWith('session-old:'))) {
      throw new Error('当前会话列表或完成回调丢失会话边界')
    }
    if (manager.getRecord(oldRun.id, 'session-old')?.status !== 'done'
      || !manager.listRecords('session-old').some((record) => record.id === oldRun.id)) {
      throw new Error('显式旧会话查询未找回已完成子任务')
    }
    await manager.close()
  })
  await check('spawn: fork 强制后台 + 继承', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const res = await manager.spawn(
      { type: 'fork', prompt: '继续', parentHistory: [{ role: 'user', content: '父消息' }] },
      { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    if (!res.async) throw new Error('fork 应强制后台')
    await new Promise((r) => setTimeout(r, 300))
    if (manager.listRecords().length < 1) throw new Error('fork 记录缺失')
  })
  await check('spawn: 未找到角色报错', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const res = await manager.spawn(
      { type: 'defined', role: 'nope', prompt: 'x' },
      { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    if (res.syncResult?.includes('未找到角色') !== true) throw new Error('应报未找到角色')
  })
  await check('spawn: 真实超时哨兵文本仍作为同步结果返回', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const res = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: '返回哨兵文本' },
      { provider: new FakeSubProvider('__TIMEOUT__'), registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    if (res.async || res.syncResult !== '__TIMEOUT__') throw new Error(`哨兵文本被误判为超时: ${JSON.stringify(res)}`)
  })
  await check('spawn: worktree 成功收尾只执行一次并回传保留信息', async () => {
    for (const dirty of [false, true]) {
      const calls: string[] = []
      const worktrees = {
        async create(name: string) {
          calls.push(`create:${name}`)
          return { path: join(TMP, 'worktree'), branch: 'agent/isolated' }
        },
        async exit(name: string) {
          calls.push(`exit:${name}`)
          return { path: join(TMP, 'worktree'), branch: 'agent/isolated', dirty }
        },
        async remove(name: string) {
          calls.push(`remove:${name}`)
        },
      } as unknown as WorktreeManager
      const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT }, worktrees)
      manager.loadRoles()
      const res = await manager.spawn(
        { type: 'defined', role: 'isolated', prompt: '隔离检查' },
        { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } },
      )
      const worktreeName = calls.find((call) => call.startsWith('create:'))?.slice('create:'.length)
      if (!worktreeName || !/^isolated-[A-Za-z0-9_-]{8,}$/.test(worktreeName)) throw new Error(`worktree 未绑定 Agent ID: ${calls.join(',')}`)
      if (calls.filter((call) => call === `exit:${worktreeName}`).length !== 1) throw new Error(`worktree exit 次数错误: ${calls.join(',')}`)
      if (dirty) {
        if (calls.some((call) => call === `remove:${worktreeName}`)) throw new Error('dirty worktree 被删除')
        if (!res.syncResult?.includes('worktree 保留待合并')) throw new Error('dirty worktree 信息未回传')
      } else if (calls.filter((call) => call === `remove:${worktreeName}`).length !== 1) {
        throw new Error(`干净 worktree 未恰好删除一次: ${calls.join(',')}`)
      }
    }
  })

  await check('spawn: 同角色并行任务使用不同 worktree', async () => {
    const created: string[] = []
    const worktrees = {
      async create(name: string) {
        created.push(name)
        return { path: join(TMP, name), branch: `wt-${name}` }
      },
      async exit(name: string) {
        return { path: join(TMP, name), branch: `wt-${name}`, dirty: false }
      },
      async remove() {},
      release() {},
    } as unknown as WorktreeManager
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT }, worktrees)
    manager.loadRoles()
    await Promise.all([
      manager.spawn({ type: 'defined', role: 'isolated', prompt: 'parallel 1', async: true }, { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } }),
      manager.spawn({ type: 'defined', role: 'isolated', prompt: 'parallel 2', async: true }, { provider: new FakeSubProvider(), registry: makeRegistry(), ctx: { cwd: TMP } }),
    ])
    for (let i = 0; i < 10 && created.length < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve))
    if (created.length !== 2 || new Set(created).size !== 2) throw new Error(`并行 worktree 名称碰撞: ${created.join(',')}`)
    await manager.close()
  })

  // ---------- spawn_agent 工具 ----------
  await check('工具: spawn_agent sync/async 返回', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const provider = new FakeSubProvider()
    const registry = makeRegistry()
    const tool = createSpawnAgentTool(manager, { provider, registry })
    const sync = await tool.execute({ type: 'defined', role: 'reviewer', prompt: '审查' }, { cwd: TMP })
    if (!sync.success || !sync.output.includes('子任务')) throw new Error(`sync 失败: ${JSON.stringify(sync)}`)
    const async = await tool.execute({ type: 'defined', role: 'reviewer', prompt: '审查', async: true }, { cwd: TMP })
    if (!async.output.includes('后台')) throw new Error(`async 失败: ${JSON.stringify(async)}`)
  })

  await check('spawn: 非 complete 停止原因记为失败并传给工具调用方', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    manager.loadRoles()
    const registry = makeRegistry()
    const result = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: '触发未知工具' },
      { provider: new UnknownToolProvider(), registry, ctx: { cwd: TMP } },
    )
    if (!result.error?.includes('unknown_tool') || manager.getRecord(result.id)?.status !== 'error') {
      throw new Error(`未知工具被误报成功: ${JSON.stringify(result)}`)
    }
    const tool = createSpawnAgentTool(manager, { provider: new UnknownToolProvider(), registry })
    const toolResult = await tool.execute({ type: 'defined', role: 'reviewer', prompt: '触发未知工具' }, { cwd: TMP })
    if (toolResult.success || !toolResult.error?.includes('unknown_tool')) {
      throw new Error(`spawn_agent 工具吞掉失败: ${JSON.stringify(toolResult)}`)
    }
  })

  await check('spawn: close 取消后记录为 cancelled', async () => {
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT })
    const slowProvider: Provider = {
      protocol: 'openai',
      async *streamChat() {
        yield { type: 'text', text: 'slow' }
        await new Promise((resolve) => setTimeout(resolve, 200))
        yield { type: 'done' }
      },
    }
    const res = await manager.spawn(
      { type: 'fork', prompt: 'slow' },
      { provider: slowProvider, registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await manager.close(1000)
    const record = manager.getRecord(res.id)
    if (record?.status !== 'cancelled') throw new Error(`取消状态错误: ${record?.status}`)
  })

  await check('spawn: 外部进程取消在心跳周期前生效', async () => {
    const store = new SubAgentStore(join(TMP, 'external-cancel-store'), 'external-cancel-session')
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT }, null, store)
    manager.loadRoles()
    const provider = new AbortAwareProvider()
    const result = await manager.spawn(
      { type: 'defined', role: 'reviewer', prompt: '等待外部取消', async: true },
      { provider, registry: makeRegistry(), ctx: { cwd: TMP, sessionId: 'external-cancel-session' } },
    )
    await provider.started
    const startedAt = Date.now()
    store.requestCancel(result.id, '外部取消')
    const waited = await manager.waitFor(result.id, 3000)
    if (waited.timedOut || waited.record?.status !== 'cancelled') throw new Error(`外部取消未及时收敛: ${waited.record?.status}`)
    if (Date.now() - startedAt >= 3000) throw new Error('外部取消仍依赖 10 秒租约心跳')
    await manager.close()
  })

  await check('spawn: close 超时主动释放持久化租约并拒绝迟到覆盖', async () => {
    const store = new SubAgentStore(join(TMP, 'shutdown-store'), 'shutdown-session')
    const manager = new SubAgentManager({ builtin: BUILTIN, user: USER, project: PROJECT }, null, store)
    let release!: () => void
    const hungProvider: Provider = {
      protocol: 'openai',
      async *streamChat() {
        yield { type: 'text', text: 'started' }
        await new Promise<void>((resolve) => { release = resolve })
        yield { type: 'done' }
      },
    }
    const result = await manager.spawn(
      { type: 'fork', prompt: 'hung' },
      { provider: hungProvider, registry: makeRegistry(), ctx: { cwd: TMP } },
    )
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve))
    await manager.close(0)
    const closed = store.load().find((record) => record.id === result.id)
    if (closed?.status !== 'cancelled' || closed.ownerId || closed.leaseExpiresAt) throw new Error('关闭超时未收敛子 Agent 租约')
    release()
    await manager.waitFor(result.id, 1000)
    if (store.load().find((record) => record.id === result.id)?.status !== 'cancelled') throw new Error('迟到结果覆盖了关闭终态')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('subagent 测试异常:', e)
  process.exit(1)
})
