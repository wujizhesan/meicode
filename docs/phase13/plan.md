# MewCode Phase13 Plan — Worktree 隔离

## 架构概览

新增 `worktree/` 层：名校验 → WorktreeManager（创建/退出/删除/清理 + 环境初始化）。SubAgentManager 对 `isolation: worktree` 角色自动建 worktree，子 Agent 的 ctx.cwd 指向 worktree 路径（explicit cwd，不 chdir）。

```
cli → WorktreeManager（repoRoot = git rev-parse --show-toplevel）→ 启动清理
SubAgentManager.spawn:
  role.isolation === 'worktree'
    → manager.create(role.name)
      ├─ 快速恢复：目录已存在 → 只读复用
      ├─ 否则 git worktree add -b wt-<name>
      └─ 环境初始化（软链 node_modules / 复制配置 / 补文件）
    → subCtx.cwd = worktree.path（explicit cwd）
    → system 注入「工作目录在 <path>」
    → 跑子 Agent
    → 完成：manager.exit → dirty 保留待合并 / 干净清理
```

依赖：worktree → node:git（spawn）；subagent → worktree。无环。

## 核心数据结构

```ts
interface WorktreeInfo {
  name: string
  path: string        // 绝对路径
  branch: string      // wt-<name>
  createdAt: number
  dirty: boolean      // 有未提交变更
}

class WorktreeManager {
  constructor(repoRoot: string)   // worktrees 根 = <repo>/.mewcode/worktrees
  async create(name: string): Promise<WorktreeInfo>
  // 名校验（validate.ts）→ 快速恢复（目录存在 → git worktree list 校验 → 复用）
  // 否则 git worktree add <path> -b wt-<name>
  // 环境初始化：symlink node_modules（junction）、复制 .env*/config*、确认 hooks 共享
  async exit(name: string): Promise<WorktreeInfo>   // git status --porcelain + git log 检查 dirty
  async remove(name: string): Promise<string>        // 保护检查 → git worktree remove
  async cleanup(olderThanDays = 7): Promise<number>  // 启动/退出清理
  isManagedPath(p: string): boolean                  // 三层过滤
}
```

## 模块设计

### worktree/validate.ts
```ts
validateWorktreeName(name: string): boolean
// 字符集 ^[a-zA-Z0-9_/-]{1,64}$（含斜杠嵌套）
// 段检查：split('/') 任一段为 '.'/'..' 拒绝
// 绝对路径/盘符（/ 开头、\、:）拒绝
```

### worktree/manager.ts
- **create**：
  1. validate name → 非法抛错
  2. 目标路径 = `<repo>/.mewcode/worktrees/<name>`；已存在 → `git worktree list` 校验在册 → 复用（不执行 git 写）
  3. 否则 `git worktree add <path> -b wt-<name>`
  4. 环境初始化：
     - node_modules：主目录存在 → `fs.symlinkSync(主 node_modules, worktree/node_modules, 'junction')`（Windows junction）
     - 配置文件：复制主目录 `.env*`、`config.local.*` 等（glob 匹配）到 worktree
     - hooks：git worktree 共享主 .git hooks ✓（无需配置，注释说明）
     - 被忽略但需要：`.mewcode/config.yaml`、`instructions.md` 等软链/复制（按规则列表）
  5. 返回 WorktreeInfo
- **exit**：`git -C <path> status --porcelain` 非空 → dirty；`git log origin/HEAD..wt-<name>` 有 commit → dirty；返回 info
- **remove**：exit 检查 → dirty → 拒绝返回原因；否则 `git worktree remove <path>` + 物理清理
- **cleanup**：扫描 worktrees 根 → 每个 exit 检查 → 非 dirty 且 age > 7 天 → remove
- **isManagedPath**：① resolve 后必须以 worktrees 根为前缀 ② name 校验通过 ③ `git worktree list` 含该路径

### subagent/types.ts（扩展）
```ts
interface AgentRole { ...; isolation?: 'worktree' }
```

### subagent/manager.ts（集成）
- spawn：`role?.isolation === 'worktree'` →
  - `const wt = await worktreeManager.create(role.name)`（失败降级为不隔离 + warn）
  - subCtx.cwd = wt.path
  - system prompt 追加 `\n\n工作目录：${wt.path}（隔离 worktree，分支 ${wt.branch}）`
  - 完成（run 结束）：`const info = await worktreeManager.exit(wt.name)` → dirty → 保留（result 附加 worktree 路径/分支）；干净 → remove
  - worktreeManager 通过构造注入 SubAgentManager（可选，null 时不隔离）

### cli.tsx
- WorktreeManager 创建（repoRoot = spawn git rev-parse）+ 启动 cleanup

## 文件组织

```
D:\MewCode\
├── src/
│   ├── worktree/
│   │   ├── types.ts
│   │   ├── validate.ts
│   │   ├── manager.ts
│   │   └── index.ts
│   ├── subagent/
│   │   ├── types.ts      — isolation 字段
│   │   └── manager.ts    — worktree 集成
│   └── cli.tsx           — 初始化 + 启动清理
├── test/worktree_test.ts — 校验/创建/初始化/保护/清理
└── docs/phase13/         — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 名校验 | 正则 + 段检查 | 防路径遍历（spec F2） |
| 快速恢复 | 目录存在只读复用 | 不重复 git 写（N3） |
| 初始化 | symlink node_modules + 复制配置 | worktree 可直接运行 |
| hooks | worktree 天然共享主 .git hooks | 无需额外配置 |
| 删除保护 | dirty 拒删 | 用户决策 |
| 清理 | 启动 + 子任务退出，>7 天 | 用户决策 |
| 集成 | subCtx.cwd = worktree.path | explicit cwd（不 chdir） |
| 失败降级 | worktree 创建失败 → 不隔离 + warn | 子任务不中断 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 创建 | manager.create（git worktree add） |
| F2 名校验 | validate.ts |
| F3 生命周期 | manager（create/exit/remove/cleanup） |
| F4 环境初始化 | manager.create 步骤 4 |
| F5 explicit cwd | subAgentManager subCtx.cwd + 缓存绝对路径确认 |
| F6 隔离模式 | subagent manager 集成 + system 注入 |
| F7 变更保护/清理 | manager.exit/remove/cleanup + 三层过滤 |
| N1 完全隔离 | 工具用 ctx.cwd（已是） |
| N2 删除保护 | remove 检查 |
| N3 快速恢复 | create 复用路径 |
