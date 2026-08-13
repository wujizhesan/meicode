# MewCode Phase12 Plan — 子 Agent 系统

## 架构概览

新增 `subagent/` 层：角色加载 → SubAgentManager（spawn/状态/后台）→ runSubAgent（复用 runAgent 跑到底）。`spawn_agent` 工具是父 Agent 的唯一入口；子 Agent 工具集经多层过滤（默认禁嵌套）。

```
cli → SubAgentManager.loadRoles（项目 agents/ > 用户 > 内置）
    → registry.register(spawn_agent 工具)
父 Agent 调用 spawn_agent → manager.spawn(req)
  ├─ defined: 空 History + 角色 system + 过滤后工具 + maxRounds + 角色权限
  ├─ fork: 父历史尾部 + 父工具集（去 spawn_agent）
  ├─ 后台分流: async 显式 / 30s 超时自动 / fork 强制
  └─ 完成 → LLM 摘要 → onResult → useStream 回流主对话「📦 [子任务 <role>] 结果」
P11 subagent Hook 动作 → manager.spawn(role, async)
```

依赖：subagent → agent/hook/tools；tui/cli → subagent。无环。

## 核心数据结构

### AgentRole / SpawnRequest / SubAgentRecord
```ts
interface AgentRole {
  name: string
  description: string
  toolsAllow?: string[]       // 白名单
  toolsDeny?: string[]        // 黑名单
  model?: string              // inherit 或缺省 = 继承父
  maxRounds?: number          // 默认 10
  permission?: PermissionMode // 子 Agent 权限模式
  content: string             // 系统提示（身份/职责/风格）
  source: 'builtin' | 'user' | 'project'
}

interface SpawnRequest {
  type: 'defined' | 'fork'
  role?: string               // defined 必填
  prompt: string
  async?: boolean
  parentHistory?: ChatMessage[]  // fork
  parentTools?: Tool[]           // fork
}

type SubAgentStatus = 'running' | 'done' | 'error'
interface SubAgentRecord {
  id: string              // sub-<ts>-<rand>
  role: string
  type: 'defined' | 'fork'
  status: SubAgentStatus
  startedAt: number
  finishedAt?: number
  tokens?: number
  result?: string         // 摘要
  error?: string
}
```

### SubAgentManager
```ts
class SubAgentManager {
  constructor(dirs: { builtin: string; user: string; project: string })
  loadRoles(): void
  getRole(name): AgentRole | undefined
  async spawn(req: SpawnRequest, opts: {
    provider; registry; ctx; maxWaitMs?: number  // 默认 30000
  }): Promise<{ id: string; syncResult?: string; async: boolean }>
  listRecords(): SubAgentRecord[]
  getRecord(id): SubAgentRecord | undefined
  setOnResult(cb: (record: SubAgentRecord) => void): void  // 回流回调
}
```

## 模块设计

### subagent/types.ts
AgentRole / SpawnRequest / SubAgentRecord / SubAgentStatus。

### subagent/loader.ts（复用 skill loader 模式）
- 四来源：项目 `agents/` > 用户 `~/.mewcode/agents/` > 内置 `src/agents/`；同名覆盖（高优先级在前）
- frontmatter：name/description 必需；toolsAllow/toolsDeny/model/maxRounds/permission 可选；坏文件跳过
- 返回 { roles, skipped }

### subagent/manager.ts
- spawn 分流：
  - defined：role 必须存在；空 History；system = 角色 content；maxRounds = 角色值 ?? 10；permission = 角色值 ?? 继承
  - fork：parentHistory 尾部 N 条（默认 10）；工具集 = parentTools 过滤
- **工具过滤（多层）**：
  ```
  filterTools(role, parentTools?):
    ① 基础集 = role.toolsAllow ?? parentTools ?? 全部内置
    ② 黑名单排除: role.toolsDeny
    ③ 全局禁止: spawn_agent 默认移除（role.toolsAllow 显式含它才保留）
    ④ 系统工具始终保留: load_skill（如注册）
  ```
- 后台分流：async:true 或 type=fork → 立即后台；否则同步等待（Promise.race 30s）→ 超时转后台 + 返回 { async: true }
- runSubAgent（内部）：复用 runAgent（maxIterations=角色 maxRounds；toolsOverride=过滤后）→ complete 即完成 → 收集输出 → LLM 摘要 → record 更新 + onResult 回调
- 记录：id/状态/开始结束时间/tokens/结果

### subagent/index.ts
- createSpawnAgentTool(manager, opts)：系统级工具 `spawn_agent`
  - 参数：type（defined|fork，默认 defined）、role、prompt、async
  - execute：manager.spawn → 返回（sync 结果 / 「已提交后台 任务ID」）
- runSubAgent 导出（测试用）

### hook/runner.ts（对接 P11）
- runSubagentAction 占位改真实：manager.spawn({ type: 'defined', role: name, prompt: '', async: true })

### tui/useStream.ts（结果回流）
- manager.setOnResult(record => 主对话 push `📦 [子任务 ${role}] ${result}` 消息 + history.push system)

### cli.tsx
- SubAgentManager 创建 + loadRoles + 注册 spawn_agent 工具 + 传 App/useStream

## 文件组织

```
D:\MewCode\
├── src/
│   ├── subagent/
│   │   ├── types.ts
│   │   ├── loader.ts
│   │   ├── manager.ts
│   │   └── index.ts          — createSpawnAgentTool + runSubAgent
│   ├── agents/               — 内置角色（code-reviewer 样板）
│   ├── hook/runner.ts        — subagent 动作对接
│   ├── tui/useStream.ts      — 结果回流
│   └── cli.tsx               — 初始化
├── test/subagent_test.ts     — 角色/过滤/spawn/后台/回流/嵌套
└── docs/phase12/             — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 工具 | spawn_agent + type 分流 | 用户决策 |
| 嵌套 | 默认禁（工具过滤移除 spawn_agent） | 用户决策 |
| 结果 | LLM 摘要回流主对话 | 用户决策 |
| fork | 强制后台 | spec |
| 超时转后台 | 30s 同步等待上限 | 防主对话卡 |
| 角色加载 | 复用 skill loader 模式 | 一致性 |
| 跑到底 | 复用 runAgent（complete 即完成） | 零重复实现 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 spawn_agent 工具 | subagent/index.ts |
| F2 角色定义 | subagent/loader.ts |
| F3 状态隔离/共享 | manager（独立 History/token；共享 provider/ctx） |
| F4 跑到底 | runSubAgent（复用 runAgent） |
| F5 多层过滤 | manager.filterTools |
| F6 后台管理 | manager（async/超时/fork/记录） |
| F7 P11 对接 | hook/runner.ts |
| N1 不污染父 | 摘要化 + 记录独立 |
| N2 嵌套防护 | 过滤默认移除 spawn_agent |
| N3 不阻塞 | 后台 + 异步通知 |
