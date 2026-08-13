# MewCode Phase14 Plan — 团队编排（Team Lead）

## 架构概览

新增 `team/` 层：小组持久化（group/tasks/mail）→ 邮箱（注册表+锁）→ 成员协程驻留（MemberHost）→ 协作工具（仅队员可见）。TeamManager 统筹：Lead 拆任务派活、成员并行执行、完成后 git 合并。

```
cli → TeamManager（读 coordinator 开关）
Lead: 拆任务 → tasks.json → spawnMember（协程驻留）→ ASSIGN
成员 MemberHost:
  ASSIGN → execute（runAgent：成员系统提示 + 协作工具 + 持久 History）
        → 完成 → 标记 idle → IDLE 消息回 Lead
  审批: 队员发计划 → Lead APPROVE/DENY → 队员继续
Lead: 全部 done → mergeAll（worktree git 合并/冲突回滚）
coordinator: 配置+env 双锁 → Lead toolsOverride 移除 write/edit
```

依赖：team → agent/tools/worktree；tui/cli → team。无环。

## 核心数据结构

```ts
interface TeamMember {
  name: string
  role: string
  workdir: string
  backend: 'coroutine'
  needsApproval: boolean
  status: 'idle' | 'busy' | 'offline'
}

interface TeamTask {
  id: string
  title: string
  assignee?: string
  status: 'todo' | 'in_progress' | 'done' | 'failed'
  depends_on?: string[]
  result?: string
}

interface MailMessage {
  from: string
  to: string          // 成员名或 '*'（广播）
  body: string
  ts: number
  read: boolean
  summary?: string
}

class TeamManager {
  constructor(root: string)  // <cwd>/.mewcode/team
  createGroup(name, lead): TeamGroup
  loadGroup(name): TeamGroup
  spawnMember(group, name, role, opts): MemberHost
  assignTask(group, task, member): Promise<void>
  listTasks(group): TeamTask[]
  updateTask(group, id, patch): void
  markMemberIdle(group, name): void
  mergeAll(group): Promise<string>   // worktree git 合并/冲突回滚
  isCoordinator(): boolean            // 配置 + 环境变量双锁
}
```

## 模块设计

### team/types.ts
TeamMember / TeamTask / MailMessage / TeamGroup（name/lead/members/tasks）。

### team/group.ts（小组持久化）
- 目录：`<cwd>/.mewcode/team/<group>/`：group.yaml（花名册）、tasks.json（任务）、mail/、members/（成员 History）
- createGroup/loadGroup：group.yaml 读写；成员增删
- tasks：listTasks/updateTask/assignTask（写 tasks.json，带锁——复用 mail 锁机制或独立 .lock）

### team/mail.ts（邮箱）
- 注册表：`mail/registry.json`（name → 邮箱文件）
- 写锁：`mail/.lock`——写入前创建（含时间戳），已存在且 <5s → 重试 3 次；>5s → 视为过期覆盖
- `send(from, to, body)`：append JSONL 到目标邮箱（to='*' → broadcast.mail）；自动 ts/read:false/summary（正文首行截断）
- `read(name, markRead)`：读自己邮箱 + broadcast.mail，过滤（to=name 或 from=name 或广播）；返回按 ts 排序
- 协议消息：正文首行 `PROTO:<type>` 解析辅助

### team/member.ts（协程驻留）
```ts
class MemberHost {
  constructor(group, member, opts: { provider; registry; ctx })
  history: History        // 持久（members/<name>.history.jsonl）
  async execute(taskTitle: string): Promise<string>
  // runAgent（成员系统提示 + 协作工具 toolsOverride + 持久 history + maxRounds 15）
  // 完成 → summary → markMemberIdle + IDLE 消息回 Lead
  async resume(): void    // 从磁盘恢复 history
}
```

### team/tools.ts（协作工具，仅队员可见）
- `team_task`：action=list|create|update|status、id/title/assignee/depends_on → 操作 tasks.json（加锁）
- `team_send`：to/body → send；body 支持协议标记（APPROVE/DENY/PROTO）
- 注入：成员的 toolsOverride 含这两个工具（+ 常规工具子集）；Lead/普通 agent 不含

### team/index.ts
- TeamManager：createGroup/loadGroup/spawnMember/assignTask/listTasks/updateTask/markMemberIdle/mergeAll/isCoordinator
- coordinator：配置（team.yaml `coordinator_enabled: true`）+ env（`MEWCOORDINATOR=1`）双锁；开启时 Lead 工具过滤 write/edit（createLeadTools）
- mergeAll：遍历成员 worktree → git merge wt-<name> → 冲突自动尝试解决（git checkout --ours/theirs 按文件）→ 失败回滚（git merge --abort）+ 上报

### cli.tsx / useStream.ts（集成）
- cli：TeamManager 创建（读配置）→ 传给 App
- useStream：Lead 侧不需要团队工具（spawn_agent 已有）——但 coordinator 模式下 Lead 的 toolsOverride 过滤——useStream 计算 toolsOverride 时若 coordinator → 移除 write/edit

## 文件组织

```
D:\MewCode\
├── src/
│   ├── team/
│   │   ├── types.ts
│   │   ├── group.ts
│   │   ├── mail.ts
│   │   ├── member.ts
│   │   ├── tools.ts
│   │   └── index.ts
│   ├── cli.tsx           — TeamManager 初始化
│   └── tui/useStream.ts  — coordinator 工具过滤
├── test/team_test.ts     — 小组/邮箱锁/任务/成员/审批/coordinator/合并
└── docs/phase14/         — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 成员驻留 | MemberHost（History 持久 + 按需 execute） | 用户决策（协程） |
| 锁 | .lock 文件 + 5s 过期 + 重试 3 次 | 并发安全 |
| 工具隐藏 | 仅成员 toolsOverride 注入 | 主入口不可见 |
| 审批 | APPROVE/DENY 首行协议 | 用户决策 |
| coordinator | 配置 + env 双锁 + toolsOverride 过滤 | spec |
| 广播 | broadcast.mail + 读时合并 | 简单可靠 |
| 合并 | git merge + 冲突自动/回滚 | spec |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 小组对象 | team/group.ts |
| F2 成员后端 | team/member.ts（协程驻留） |
| F3 协作工具 | team/tools.ts + member toolsOverride |
| F4 消息系统 | team/mail.ts |
| F5 Lead 流程 | TeamManager（tasks + spawnMember + mergeAll） |
| F6 生命周期 | member.execute + markMemberIdle + IDLE 消息 |
| F7 coordinator | TeamManager.isCoordinator + useStream 过滤 |
| N1 锁安全 | mail.ts 锁 |
| N2 不静默降级 | 后端检测提示 |
| N3 恢复 | members/<name>.history.jsonl |
