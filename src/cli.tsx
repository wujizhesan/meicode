import { join } from 'node:path'
import { loadConfigWithMcp } from './config/loader.ts'
import { parseArgs, runFastCommand } from './cli-fast.ts'
import { createProvider } from './provider/index.ts'
import { createTools, ToolRegistry } from './tools/index.ts'
import { RuleEngine } from './permission/index.ts'
import type { McpClientManager } from './mcp/manager.ts'
import { SkillManager, createLoadSkillTool } from './skill/index.ts'
import { loadHooks, HookEngine, setSubagentSpawner } from './hook/index.ts'
import { SubAgentManager, SubAgentStore, createSpawnAgentTool, agentDirs } from './subagent/index.ts'
import { WorktreeManager } from './worktree/index.ts'
import { createLeadTools } from './team/lead-tools.ts'
import type { ToolContext } from './tools/index.ts'
import { TeamManager } from './team/index.ts'
import { initLogger, log } from './log.ts'
import type { ProviderConfig } from './config/types.ts'
import { createRuntimeId } from './runtime/index.ts'
import { runHeadless } from './runtime/headless.ts'
import { startRuntimeServices } from './runtime/service-host.ts'
import { settleCloseTask } from './runtime/close-timeout.ts'
import { bootstrapSessionRuntime } from './runtime/session-bootstrap.ts'
import { projectStatePath, userStatePath } from './state-paths.ts'

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (runFastCommand(args)) return
  const { config, run: runTask, acpPort, acpHost, acpToken, a2aPort, a2aToken, a2aPushAllowedUrls, resume, yolo } = args
  initLogger(process.cwd())
  let cfg: ProviderConfig
  let mcpServers
  let a2aAgents: import('./a2a/config.ts').A2aAgentConfig[] = []
  try {
    const loaded = loadConfigWithMcp(config)
    cfg = loaded.provider
    mcpServers = loaded.mcpServers
    a2aAgents = loaded.a2aAgents
    for (const s of loaded.a2aSkipped) console.warn(`[A2A] 配置跳过: ${s}`)
    for (const s of loaded.mcpSkipped) console.warn(`[MCP] 配置跳过: ${s}`)
  } catch (e) {
    log('error', `配置加载失败: ${(e as Error).message}`)
    console.error(`MeiCode: ${(e as Error).message}`)
    process.exit(1)
  }

  if (!process.stdin.isTTY && !runTask && !acpPort && !a2aPort) {
    log('error', '非 TTY 环境启动被拒')
    console.error('MeiCode: 需要交互式终端（TTY）才能运行 TUI(--run/--acp-port 除外)，请直接在终端中启动')
    process.exit(1)
  }

  const provider = createProvider(cfg)
  const registry = new ToolRegistry()
  createTools({ cwd: process.cwd() }).forEach((t) => registry.register(t))
  if (a2aAgents.length > 0) {
    const { createA2aTools } = await import('./a2a/tools.ts')
    createA2aTools(a2aAgents).forEach((t) => registry.register(t))
  }
  const engine = new RuleEngine(
    userStatePath('rules.yaml'),
    projectStatePath(process.cwd(), 'rules.yaml'),
    projectStatePath(process.cwd(), 'rules.local.yaml'),
  )
  engine.loadAll()
  let mcpManager: McpClientManager | null = null
  if (mcpServers.length > 0 && !runTask) {
    const { McpClientManager } = await import('./mcp/manager.ts')
    mcpManager = new McpClientManager(mcpServers)
  }

  let sessionRuntime
  try {
    sessionRuntime = await bootstrapSessionRuntime({
      cwd: process.cwd(),
      resume,
      recoverLatest: !runTask && !acpPort && !a2aPort,
    })
  } catch (error) {
    console.error(`MeiCode: ${(error as Error).message}`)
    process.exit(1)
  }
  const { history, memory, sessionId, runtimeEvents, removed, recovered } = sessionRuntime
  if (removed > 0) console.warn(`[记忆] 已清理 ${removed} 个过期会话（>30 天）`)
  if (recovered) {
    log('info', `会话恢复 ${recovered.id}（${recovered.count} 条）`)
    console.log(`[记忆] 已恢复会话 ${recovered.id}（${recovered.count} 条消息）`)
  }

  // P10：Skill 系统初始化（内置/用户/项目三级）
  const skillManager = new SkillManager({
    builtin: join(import.meta.dirname, 'skills'),
    user: userStatePath('skills'),
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
  await hookEngine.fire('session_start', { cwd: process.cwd(), sessionId }).catch(() => {})
  let sessionHookQueue = Promise.resolve()
  const closeSessionScope = async (currentSessionId: string | undefined): Promise<void> => {
    await hookEngine.fire('session_end', { cwd: process.cwd(), sessionId: currentSessionId })
    if (currentSessionId) hookEngine.clearSession(currentSessionId)
    engine.clearSessionRules(currentSessionId)
  }

  // P12/P13：子 Agent 系统 + Worktree 隔离
  const worktreeManager = new WorktreeManager(process.cwd())
  const cleaned = await worktreeManager.cleanup(7).catch(() => 0)
  if (cleaned > 0) console.warn(`[Worktree] 已清理 ${cleaned} 个过期 worktree`)
  const subAgentStore = new SubAgentStore(projectStatePath(process.cwd(), 'subagents'), sessionId)
  const subAgentManager = new SubAgentManager(agentDirs(process.cwd()), worktreeManager, subAgentStore)
  subAgentManager.loadRoles()
  registry.register(createSpawnAgentTool(subAgentManager, { provider, registry }))
  // 成员/子 Agent 共享上下文：接入权限系统（黑名单/路径沙箱/规则引擎对成员生效；
  // 无 UI ask 通道，default 模式下 ask 会被拒绝——成员只走界内/规则允许的操作）
  const agentCtx: ToolContext = {
    cwd: process.cwd(),
    sessionId,
    runtimeEvents,
    agentId: createRuntimeId('agent'),
    timeoutMs: 30000,
    permission: { mode: yolo ? 'permissive' : 'unattended', engine, autoAcceptEdits: false },
    hooks: hookEngine,
  }

  setSubagentSpawner((role) => {
    void subAgentManager
      .spawn({ type: 'defined', role, prompt: `请以 ${role} 角色执行当前任务`, async: true }, { provider, registry, ctx: agentCtx })
      .catch(() => {})
  })

  // P14：团队编排
  const teamManager = new TeamManager(
    projectStatePath(process.cwd(), 'team'),
    process.cwd(),
    { provider, registry, ctx: agentCtx },
    worktreeManager,
  )
  if (teamManager.isCoordinator()) {
    console.warn('[团队] coordinator 模式已启用——Lead 写文件工具已剥夺')
  }
  const onSessionChange = (nextSessionId: string): void => {
    const previousSessionId = agentCtx.sessionId
    subAgentManager.setSession(nextSessionId)
    agentCtx.sessionId = nextSessionId
    teamManager.setSessionId(nextSessionId)
    sessionHookQueue = sessionHookQueue
      .then(async () => {
        await closeSessionScope(previousSessionId)
        await hookEngine.fire('session_start', { cwd: process.cwd(), sessionId: nextSessionId })
      })
      .catch((error) => console.warn(`[Hook] session 切换事件失败: ${(error as Error).message}`))
  }
  // 跨重启恢复团队成员(workdir/history 复用)
  const restored = await teamManager.restore(subAgentManager.listRoles())
  if (restored.length > 0) {
    console.log(`[团队] 已恢复 ${restored.length} 个成员: ${restored.join(', ')}`)
  }

  // P14：Lead 侧编排工具注册——模型一句话完成建组/派生/派活
  for (const t of createLeadTools(teamManager)) registry.register(t)
  // P14：成员协作工具注册（全局一份，执行时按 ctx.cwd 解析成员身份）
  for (const t of teamManager.memberTools()) registry.register(t)

  let coreClosePromise: Promise<void> | null = null
  const closeCoreResources = (): Promise<void> => {
    if (!coreClosePromise) {
      coreClosePromise = (async () => {
        await settleCloseTask('session_end Hook', async () => {
          await sessionHookQueue
          await closeSessionScope(agentCtx.sessionId)
        })
        await Promise.all([
          settleCloseTask('Team Manager', () => teamManager.close()),
          settleCloseTask('SubAgent Manager', () => subAgentManager.close()),
          ...(mcpManager ? [settleCloseTask('MCP Manager', () => mcpManager.closeAll())] : []),
        ])
        await settleCloseTask('app_exit Hook', () => hookEngine.fire('app_exit', { cwd: process.cwd() }))
      })()
    }
    return coreClosePromise
  }

  // --run 自主模式:非交互执行任务(无人值守,输出结果后退出)
  // 团队编排在自主模式下可用——team_assign 同步等待专家完成
  if (runTask) {
    try {
      await runHeadless(runTask, { provider, history, registry, engine, memory, teamManager, hooks: hookEngine, contextWindow: cfg.context_window ?? 131072, yolo: yolo ?? false })
    } finally {
      await closeCoreResources()
    }
    process.exit(0)
  }

  const serviceHost = await startRuntimeServices({
    provider,
    registry,
    engine,
    cwd: process.cwd(),
    memory,
    contextWindow: cfg.context_window ?? 131072,
    permissionMode: yolo ? 'permissive' : 'unattended',
    hooks: hookEngine,
    acp: acpPort ? { port: acpPort, host: acpHost, authToken: acpToken || process.env.MEICODE_ACP_TOKEN } : undefined,
    a2a: a2aPort ? { port: a2aPort, authToken: a2aToken || process.env.MEICODE_A2A_TOKEN, pushAllowedUrls: a2aPushAllowedUrls } : undefined,
  }).catch(async (error) => {
    await closeCoreResources()
    log('error', `服务启动失败: ${(error as Error).message}`)
    console.error(`MeiCode: 服务启动失败: ${(error as Error).message}`)
    process.exit(1)
  })

  let shuttingDown = false
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await Promise.all([
      closeCoreResources(),
      settleCloseTask('ACP/A2A 服务', () => serviceHost.close()),
    ])
    process.exit(code)
  }
  process.once('SIGINT', () => void shutdown(130))
  process.once('SIGTERM', () => void shutdown(143))

  const [{ render }, { createElement }, { App }] = await Promise.all([import('ink'), import('react'), import('./tui/App.tsx')])
  const app = render(createElement(App, {
    provider,
    history,
    registry,
    engine,
    mcpManager,
    contextWindow: cfg.context_window ?? 131072,
    memory,
    skillManager,
    hooks: hookEngine,
    subAgentManager,
    teamManager,
    onSessionChange,
  }))
  await app.waitUntilExit()
  await shutdown(0)
}

void main()
