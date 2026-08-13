import { render } from 'ink'
import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfigWithMcp } from './config/loader.ts'
import { createProvider } from './provider/index.ts'
import { History } from './session/history.ts'
import { App } from './tui/App.tsx'
import { createTools, ToolRegistry } from './tools/index.ts'
import { RuleEngine } from './permission/index.ts'
import { McpClientManager } from './mcp/index.ts'
import { SessionStore, loadInstructions, newSessionId } from './memory/index.ts'
import { SkillManager, createLoadSkillTool } from './skill/index.ts'
import { loadHooks, HookEngine, setSubagentSpawner } from './hook/index.ts'
import { SubAgentManager, createSpawnAgentTool, agentDirs } from './subagent/index.ts'
import { WorktreeManager } from './worktree/index.ts'
import { createLeadTools } from './team/lead-tools.ts'
import { runAgent } from './agent/loop.ts'
import { buildPrompt } from './agent/prompt/index.ts'
import { buildNotesIndex } from './memory/notes.ts'
import type { ToolContext } from './tools/index.ts'
import { TeamManager } from './team/index.ts'
import { createAcpServer } from './acp.ts'
import { initLogger, log } from './log.ts'
import type { MemoryContext } from './tui/useStream.ts'
import type { ProviderConfig } from './config/types.ts'

function parseArgs(argv: string[]): { config?: string; run?: string; acpPort?: number } {
  let config: string | undefined
  let run: string | undefined
  let acpPort: number | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      config = argv[i + 1]
      i++
    } else if (argv[i] === '--run' && argv[i + 1]) {
      run = argv[i + 1]
      i++
    } else if (argv[i] === '--acp-port' && argv[i + 1]) {
      acpPort = Number(argv[i + 1])
      i++
    }
  }
  return { config, run, acpPort }
}

export async function main(): Promise<void> {
  initLogger(process.cwd())
  const { config, run: runTask, acpPort } = parseArgs(process.argv.slice(2))
  let cfg: ProviderConfig
  let mcpServers
  try {
    const loaded = loadConfigWithMcp(config)
    cfg = loaded.provider
    mcpServers = loaded.mcpServers
    for (const s of loaded.mcpSkipped) console.warn(`[MCP] 配置跳过: ${s}`)
  } catch (e) {
    log('error', `配置加载失败: ${(e as Error).message}`)
    console.error(`MeiCode: ${(e as Error).message}`)
    process.exit(1)
  }

  if (!process.stdin.isTTY && !runTask && !acpPort) {
    log('error', '非 TTY 环境启动被拒')
    console.error('MeiCode: 需要交互式终端（TTY）才能运行 TUI(--run/--acp-port 除外)，请直接在终端中启动')
    process.exit(1)
  }

  const provider = createProvider(cfg)
  const history = new History()
  const registry = new ToolRegistry()
  createTools({ cwd: process.cwd() }).forEach((t) => registry.register(t))
  const engine = new RuleEngine(
    join(homedir(), '.mewcode', 'rules.yaml'),
    join(process.cwd(), '.mewcode', 'rules.yaml'),
    join(process.cwd(), '.mewcode', 'rules.local.yaml'),
  )
  engine.loadAll()
  const mcpManager = mcpServers.length > 0 ? new McpClientManager(mcpServers) : null

  // P8：记忆系统初始化（清理 + 恢复 + 指令 + 笔记目录）
  const sessionStore = new SessionStore(join(process.cwd(), '.mewcode', 'sessions'))
  const removed = sessionStore.cleanup(30)
  if (removed > 0) console.warn(`[记忆] 已清理 ${removed} 个过期会话（>30 天）`)
  const recovered = sessionStore.recoverLatest()
  if (recovered) {
    for (const m of recovered.messages) history.push(m)
    log('info', `会话恢复 ${recovered.id}（${recovered.messages.length} 条）`)
    console.log(`[记忆] 已恢复会话 ${recovered.id}（${recovered.messages.length} 条消息）`)
  }
  const sessionId = recovered?.id ?? newSessionId()
  const instructions = await loadInstructions(process.cwd())
  const memory: MemoryContext = {
    sessionStore,
    sessionId,
    instructions: instructions || undefined,
    noteUserDir: join(homedir(), '.mewcode', 'memory'),
    noteProjectDir: join(process.cwd(), '.mewcode', 'memory'),
  }

  // P10：Skill 系统初始化（内置/用户/项目三级）
  const skillManager = new SkillManager({
    builtin: join(import.meta.dirname, 'skills'),
    user: join(homedir(), '.mewcode', 'skills'),
    project: join(process.cwd(), 'skills'),
  })
  const skillLoad = skillManager.loadAll()
  if (skillLoad.unavailable.length > 0) {
    console.warn(`[Skill] 不可用: ${skillLoad.unavailable.join(', ')}`)
  }
  registry.register(createLoadSkillTool(skillManager))

  // P11：Hook 系统
  const { rules: hookRules, skipped: hookSkipped } = loadHooks(process.cwd())
  if (hookSkipped > 0) console.warn(`[Hook] ${hookSkipped} 条规则被跳过`)
  const hookEngine = new HookEngine(hookRules)
  await hookEngine.fire('app_start', { cwd: process.cwd() }).catch(() => {})
  await hookEngine.fire('session_start', { cwd: process.cwd() }).catch(() => {})

  // P12/P13：子 Agent 系统 + Worktree 隔离
  const worktreeManager = new WorktreeManager(process.cwd())
  const cleaned = await worktreeManager.cleanup(7).catch(() => 0)
  if (cleaned > 0) console.warn(`[Worktree] 已清理 ${cleaned} 个过期 worktree`)
  const subAgentManager = new SubAgentManager(agentDirs(process.cwd()), worktreeManager)
  subAgentManager.loadRoles()
  registry.register(createSpawnAgentTool(subAgentManager, { provider, registry }))
  // 成员/子 Agent 共享上下文：接入权限系统（黑名单/路径沙箱/规则引擎对成员生效；
  // 无 UI ask 通道，default 模式下 ask 会被拒绝——成员只走界内/规则允许的操作）
  const agentCtx = {
    cwd: process.cwd(),
    timeoutMs: 30000,
    // 成员/子 Agent:permissive(未命中规则放行)——成员无 ask 通道,default 下
    // 任何未命中规则的工具调用都失败(实战发现:经理调 team_spawn 被拦);
    // 安全性由 rootLock(写限 worktree)+ 黑名单(硬拦)+ 命令围栏保证
    permission: { mode: 'permissive' as const, engine, autoAcceptEdits: false },
    hooks: hookEngine,
  }

  setSubagentSpawner((role) => {
    void subAgentManager
      .spawn({ type: 'defined', role, prompt: `请以 ${role} 角色执行当前任务`, async: true }, { provider, registry, ctx: agentCtx })
      .catch(() => {})
  })

  // P14：团队编排
  const teamManager = new TeamManager(
    join(process.cwd(), '.mewcode', 'team'),
    process.cwd(),
    { provider, registry, ctx: agentCtx },
    worktreeManager,
  )
  if (teamManager.isCoordinator()) {
    console.warn('[团队] coordinator 模式已启用——Lead 写文件工具已剥夺')
  }
  // 跨重启恢复团队成员(workdir/history 复用)
  const restored = await teamManager.restore()
  if (restored.length > 0) {
    console.log(`[团队] 已恢复 ${restored.length} 个成员: ${restored.join(', ')}`)
  }

  // P14：Lead 侧编排工具注册——模型一句话完成建组/派生/派活
  for (const t of createLeadTools(teamManager)) registry.register(t)
  // P14：成员协作工具注册（全局一份，执行时按 ctx.cwd 解析成员身份）
  for (const t of teamManager.memberTools()) registry.register(t)

  // --run 自主模式:非交互执行任务(无人值守,输出结果后退出)
  // 团队编排在自主模式下可用——team_assign 同步等待专家完成
  if (runTask) {
    await runHeadless(runTask, { provider, history, registry, engine, memory, teamManager })
    process.exit(0)
  }

  // ACP server:编程入口(脚本/其他工具通过 HTTP+SSE 驱动 agent)
  if (acpPort) {
    const memoryTail = memory?.instructions || memory?.noteUserDir || memory?.noteProjectDir
      ? `\n\n## 项目指令\n${memory?.instructions ?? '（无）'}\n\n## 记忆索引\n${
          memory?.noteUserDir && memory?.noteProjectDir ? buildNotesIndex(memory.noteUserDir, memory.noteProjectDir) : '（无）'
        }`
      : ''
    const acpServer = createAcpServer({ provider, registry, engine, cwd: process.cwd(), memoryTail })
    acpServer.listen(acpPort, () => {
      console.log(`[ACP] 服务已启动 :${acpPort} (POST /session/new → /session/:id/prompt)`)
    })
  }

  render(
    <App
      provider={provider}
      history={history}
      registry={registry}
      engine={engine}
      mcpManager={mcpManager}
      contextWindow={cfg.context_window ?? 1000000}
      memory={memory}
      skillManager={skillManager}
      hooks={hookEngine}
      subAgentManager={subAgentManager}
      teamManager={teamManager}
    />,
  )
}

// --run 自主模式:无 UI 跑一个任务(真实 API,输出流式到 stdout)
// 权限: autoAcceptEdits=true 非交互不弹窗;团队可用(team_assign 同步等专家)
async function runHeadless(
  task: string,
  opts: {
    provider: ReturnType<typeof createProvider>
    history: History
    registry: ToolRegistry
    engine: RuleEngine
    memory: MemoryContext
    teamManager: TeamManager
  },
): Promise<void> {
  const { provider, history, registry, engine, memory } = opts
  const memoryTail = memory?.instructions || memory?.noteUserDir || memory?.noteProjectDir
    ? `\n\n## 项目指令\n${memory?.instructions ?? '（无）'}\n\n## 记忆索引\n${
        memory?.noteUserDir && memory?.noteProjectDir ? buildNotesIndex(memory.noteUserDir, memory.noteProjectDir) : '（无）'
      }`
    : ''
  const ctx: ToolContext = {
    cwd: process.cwd(),
    timeoutMs: 30000,
    // headless 无人值守:permissive(未命中规则放行,黑名单/只读豁免仍生效),不弹窗
    permission: { mode: 'permissive', engine, autoAcceptEdits: true },
  }
  history.push({ role: 'user', content: task })
  const agent = runAgent({
    provider,
    history,
    registry,
    ctx,
    maxIterations: 50,
    mode: 'full',
    systemPrompt: buildPrompt('full') + memoryTail,
    unknownToolLimit: 2,
    // 团队任务进行中时纯文本轮不判 complete(防"[等待]"当最终输出中断编排)
    teamBusy: () => opts.teamManager.listGroups().some((g) => opts.teamManager.listTasks(g).some((t) => t.status === 'in_progress')),
  })
  let finalError = ''
  for await (const ev of agent.events) {
    if (ev.type === 'text') process.stdout.write(ev.text)
    else if (ev.type === 'progress' && ev.round > 1) process.stdout.write(`\n[round ${ev.round}] `)
  }
  const result = await agent.done
  if (result.errorMessage) finalError = result.errorMessage
  // 等待团队任务完成(经理/专家协程)——进程退出会杀掉后台协程(实战发现)
  // 主会话可能用了异步指派,经理还在跑就 exit 会丢任务(baidupan 轮:120s 死限提前退出,
  // 子任务②协程被杀、history 未 persist、API 报告丢失)
  // 无硬死限(10 分钟兜底) + 卡死检测(60s 无日志活动且有 in_progress → 协程真死才退出)
  const LOG_FILE = join(process.cwd(), '.mewcode', 'meicode.log')
  // 从等待开始计时(不能用文件旧 mtime——历史日志会让首轮就误判卡死)
  let lastLogMtime = Date.now()
  const deadline = Date.now() + 600000
  let waited = false
  while (Date.now() < deadline) {
    const groups = opts.teamManager.listGroups()
    const busy = groups.some((g) => opts.teamManager.listTasks(g).some((t) => t.status === 'in_progress'))
    if (!busy) break
    if (!waited) {
      console.log('[等待] 团队任务执行中...')
      waited = true
    }
    await new Promise((r) => setTimeout(r, 3000))
    let mtime = lastLogMtime
    try {
      mtime = statSync(LOG_FILE).mtimeMs
    } catch {
      // 日志文件不存在时保持上次值
    }
    if (mtime > lastLogMtime) {
      lastLogMtime = mtime // 有活动(成员在跑)→ 重置卡死计时
    } else if (Date.now() - lastLogMtime > 60000) {
      console.log('[等待] 团队任务卡死(60s 无日志活动),退出')
      break
    }
  }
  if (waited) console.log('[等待] 团队任务已结束')
  console.log(`\n\n[完成] reason=${result.reason} rounds=${result.rounds} tokens=${result.totalTokens}${finalError ? `\n[错误] ${finalError}` : ''}`)
}

void main()
