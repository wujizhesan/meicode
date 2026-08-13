// 子 Agent 系统测试：角色/过滤/spawn/后台/回流/嵌套
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SubAgentManager, createSpawnAgentTool, loadAgentRoles, parseAgentFile } from '../src/subagent/index.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import type { Tool } from '../src/tools/index.ts'

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
  })
  await check('角色: 项目覆盖内置', () => {
    writeFileSync(join(PROJECT, 'reviewer.md'), '---\nname: reviewer\ndescription: 项目版\nmax_rounds: 8\n---\n项目版正文', 'utf8')
    const roles = loadAgentRoles({ builtin: BUILTIN, user: USER, project: PROJECT })
    const r = roles.find((x) => x.name === 'reviewer')
    if (!r || r.maxRounds !== 8 || r.source !== 'project') throw new Error(`覆盖失败: ${JSON.stringify(r)}`)
  })

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
    if (!onResultCalled) throw new Error('onResult 未回调')
    const records = manager.listRecords()
    if (records.length !== 1 || records[0].status !== 'done') throw new Error('记录状态不符')
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

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('subagent 测试异常:', e)
  process.exit(1)
})
