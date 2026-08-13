# MewCode Phase5 Plan — 权限系统

## 架构概览

新增 `permission/` 层，位于 tools 之前：runAgent 执行工具前先裁决。五层裁决链纯函数化（可测），人在回路通过 ToolContext.ask 回调由 TUI 注入。

```
runAgent 执行工具前:
  checkPermission(call, ctx) → allow | deny(reason) | ask
    ├─ deny → 结构化结果 [权限拒绝] 回灌（循环继续）
    └─ ask → ctx.ask(call) → 四态（本次/会话/永久/拒绝）
             ├─ 本次 → 放行一次
             ├─ 会话 → 写会话级规则
             ├─ 永久 → 追加项目级 rules.yaml
             └─ 拒绝 → 结构化拒绝回灌
```

依赖方向：agent → permission（纯逻辑）；tui → permission（弹窗回调 + /mode）。

## 核心数据结构

### 裁决类型
```ts
type PermissionMode = 'strict' | 'default' | 'permissive'

interface Rule {
  tool: string                 // 'run_command' | 'read_file' | ...
  pattern: string              // 'git *' | 'src/**'
  action: 'allow' | 'deny'
  source: 'user' | 'project' | 'local' | 'session'
}

type Decision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }   // 黑名单/沙箱/规则/模式
  | { type: 'ask' }                    // 人在回路

type AskResult = 'once' | 'session' | 'forever' | 'deny'
```

### ToolContext 扩展
```ts
interface ToolContext {
  cwd: string
  timeoutMs?: number
  permission?: PermissionContext       // 裁决上下文（mode + 规则引擎）
  ask?: (call: ToolCallInfo) => Promise<AskResult>   // 人在回路（TUI 注入）
}
```

### 规则文件格式（三层 YAML 同构）
```yaml
mode: default                 # 可选：权限模式（用户级可设）
rules:
  - tool: run_command
    pattern: "git *"
    action: allow
  - tool: read_file
    pattern: "src/**"
    action: allow
```

## 模块设计

### permission/types.ts
PermissionMode / Rule / Decision / AskResult / RuleSource / ToolCallInfo（name + args 摘要）。

### permission/blacklist.ts
硬编码正则数组（不可配置），匹配 run_command 的完整命令串：
```ts
const DANGEROUS_PATTERNS: { re: RegExp; desc: string }[] = [
  { re: /^\s*rm\s+(-{1,2}[a-zA-Z]+[rf][a-zA-Z]*\s+)*\/\s*$/i, desc: 'rm 根目录删除' },
  { re: /^\s*(del|erase|rd|rmdir)\s+\/s(\s+\/q)?/i, desc: 'Windows 递归删除' },
  { re: /^\s*format\s+/i, desc: '格式化磁盘' },
  { re: /^\s*diskpart\s+/i, desc: '磁盘分区操作' },
  // ... 保持保守（宁缺毋滥，误伤最少）
]
match(command: string): { matched: boolean; desc: string }
```

### permission/sandbox.ts
```ts
async function resolveReal(target: string): Promise<string>
// realpath(target)；文件不存在时对最深的已存在祖先 realpath，再拼接剩余段
async function isPathAllowed(target: string, cwd: string): Promise<boolean>
// resolveReal 后：real === cwd || real.startsWith(cwd + path.sep)
```

### permission/rules.ts（RuleEngine）
```ts
class RuleEngine {
  constructor(userFile, projectFile, localFile)
  loadAll(): void            // 读三层 YAML，解析失败跳过该层（N1）
  addSessionRule(rule: Rule) // 会话级临时
  match(call: ToolCallInfo): Rule | null
  // 顺序：session → local → project → user；同层同工具多条：deny 优先
  appendProjectRule(rule: Rule): void   // 永久放行写入项目级文件
}
```
模式匹配：工具名精确 + 模式用 minimatch（glob）。

### permission/index.ts（裁决入口）
```ts
async function checkPermission(call, ctx: { cwd, mode, engine }): Promise<Decision>
// ① run_command → 黑名单命中 → deny
// ② 文件工具 → sandbox.isPathAllowed
//    false → engine.match：allow→放行 / deny→拒 / 未命中 → 按模式
// ③ engine.match → 命中裁决
// ④ 未命中 → strict deny / permissive allow / default ask
```
模式解析：`ctx.mode`（会话覆盖）?? 用户级 YAML mode ?? 'default'。

### permission/store.ts
会话级规则存储（内存 Map）+ appendProjectRule（读-追加-写项目级 YAML，含文件不存在创建）。

### agent/loop.ts（改造）
executeOne 前裁决：
```ts
const permission = ctx.permission
if (permission) {
  const decision = await checkPermission(call, { cwd: ctx.cwd, mode: permission.mode, engine: permission.engine })
  if (decision.type === 'ask') {
    const askResult = ctx.ask ? await ctx.ask({ name: call.name, args: call.arguments }) : 'deny'
    if (askResult === 'once') { /* 放行一次，不记录 */ }
    else if (askResult === 'session') { permission.engine.addSessionRule(allow rule) }
    else if (askResult === 'forever') { permission.engine.appendProjectRule(allow rule) }
    else { return { success: false, output: '', error: '[权限拒绝] 用户拒绝' } }
  } else if (decision.type === 'deny') {
    return { success: false, output: '', error: `[权限拒绝] ${decision.reason}` }
  }
}
// 通过 → executeOne 原有逻辑
```

### tui/App.tsx（改造）
- 弹窗升级为四态：`pendingAsk: { call, resolve }`——渲染「⚠ 权限请求: 工具 参数（Enter 本次 / S 会话 / P 永久 / Esc 拒绝）」
- `/mode strict|default|permissive` 命令切换（useStream 状态）
- ctx.ask 注入

### tui/useStream.ts（改造）
- mode 状态（默认 'default'，从规则 YAML 读）
- ctx.permission = { mode, engine }（engine 在 cli 初始化）

### cli.tsx（改造）
- 初始化 RuleEngine（加载三层规则文件）
- 创建 ctx 传给 useStreamingChat

## 模块交互

```
cli → RuleEngine.loadAll()（三层 YAML）
    → useStream（ctx.permission = {mode, engine}）
    → runAgent → executeOne 前 checkPermission
        ├─ deny → [权限拒绝] 回灌 → 循环继续
        └─ ask → App 四态弹窗 → once/session/forever/deny
```

## 文件组织

```
D:\MewCode\
├── src/
│   ├── permission/
│   │   ├── types.ts
│   │   ├── blacklist.ts
│   │   ├── sandbox.ts
│   │   ├── rules.ts          — RuleEngine
│   │   ├── store.ts          — 会话规则 + 永久写入
│   │   └── index.ts          — checkPermission 裁决链
│   ├── agent/loop.ts         — executeOne 前裁决
│   ├── tools/types.ts        — ToolContext 扩展
│   ├── tui/App.tsx           — 四态弹窗 + /mode
│   ├── tui/useStream.ts      — mode + permission 上下文
│   └── cli.tsx               — RuleEngine 初始化
├── test/
│   └── permission_test.ts    — 黑名单/沙箱/规则/优先级/模式/人在回路
└── docs/phase5/              — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| glob 匹配 | `minimatch` 依赖（小、成熟） | 规则模式标准实现 |
| 沙箱解析 | realpath + 最深已存在祖先兜底 | 符号链接逃逸防护 + 文件不存在场景 |
| 黑名单 | 正则数组硬编码 | 用户要求不可配置 |
| 拒绝语义 | 结构化 ToolResult error | 循环继续（F7） |
| 模式覆盖 | 会话内存覆盖用户 YAML mode | /mode 即切即用 |
| 永久放行 | 追加项目级 rules.yaml | 用户决策 |
| 规则解析失败 | 警告 + 跳过该层 | 不阻塞（N1） |
| 同层冲突 | deny 优先 | 安全惯例 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 黑名单 | blacklist.ts + checkPermission ① |
| F2 路径沙箱 | sandbox.ts + ② |
| F3 三层规则 | rules.ts + store.ts |
| F4 权限模式 | types.ts mode + checkPermission ④ + /mode |
| F5 人在回路 | ask 回调 + App 四态弹窗 |
| F6 优先级 | rules.ts match 顺序 + deny 优先 |
| F7 拒绝不终止 | loop.ts 结构化回灌 |
| N1 失败跳过 | rules.ts loadAll |
| N2 黑名单不可配置 | 硬编码无入口 |
| N3 模态弹窗 | App pendingAsk 复用模式 |
| N4 纯本地 | 无网络 |
