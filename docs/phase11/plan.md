# MewCode Phase11 Plan — Hook 系统

## 架构概览

新增 `hook/` 层：YAML 加载校验 → 条件匹配 → 动作执行 → 事件引擎。Agent 循环与 useStream 在生命周期节点调用引擎。

```
cli 启动 → loader 加载 hooks.yaml（项目+用户合并）→ 校验 → HookEngine
loop 每轮:
  round_start → engine.fire('round_start') → collectInjections() → msgs 加 system
  executeOne: 权限裁决 → engine.intercept(call) → 拦截 → [Hook 拦截] 回灌
  executeBatch 后 → engine.fire('tool_after')
  round_end → engine.fire('round_end')
useStream: send 后 fire('message')；session_start/end、app_start/exit 在 cli 层
```

依赖：hook → tools/permission 类型；loop/useStream → hook。无环。

## 核心数据结构

### HookRule / 事件 / 条件 / 动作
```ts
type HookEventName =
  | 'session_start' | 'session_end' | 'round_start' | 'round_end'
  | 'message' | 'tool_before' | 'tool_after' | 'app_start' | 'app_exit'

interface HookClause { match: string; pattern: string }  // match: 'name'|'args.command'|'content'

interface HookCondition { all?: HookClause[]; any?: HookClause[] }

type HookAction =
  | { type: 'command'; command: string; timeout?: number }
  | { type: 'inject_prompt'; content: string }
  | { type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { type: 'subagent'; name: string }

interface HookRule {
  event: HookEventName
  if?: HookCondition
  action: HookAction
  once?: boolean
  async?: boolean       // 顶层 async；tool_before 禁止
  fired?: boolean       // once 运行时标记
}

interface HookContext {
  cwd: string
  call?: { name: string; args: Record<string, unknown> }  // tool_before/after
  message?: ChatMessage                                    // message
  round?: number
}
```

### HookEngine
```ts
class HookEngine {
  constructor(rules: HookRule[])
  async fire(event: HookEventName, ctx: HookContext): Promise<void>
  // 动作执行：command(10s 超时)/http(fire-and-forget)/subagent(占位日志)
  // once 检查 + 标记；async 动作不 await；失败 try/catch + console.warn
  async intercept(call, cwd): Promise<string | null>
  // 仅 tool_before 规则：条件命中 → 返回拒绝原因（含规则匹配信息）；未命中 null
  collectInjections(): string[]   // 本轮 round_start 注入的 prompt（缓冲）
  resetRound(): void              // 轮次结束清缓冲
}
```

## 模块设计

### hook/types.ts
HookEventName / HookClause / HookCondition / HookAction / HookRule / HookContext。

### hook/matcher.ts（条件匹配，复用权限规则语法）
```ts
matchPattern(value: string, pattern: string): boolean
// ! 前缀 → 反向；/re/ → 正则；含 * → minimatch；否则精确
matchClause(value: unknown, clause: HookClause): boolean
// match 字段路径：'args.command' → 深层取值
matchCondition(data: Record<string, unknown>, cond: HookCondition): boolean
// all: 全部满足；any: 任一满足；二选一
```

### hook/loader.ts
- 路径：项目 `<cwd>/.mewcode/hooks.yaml` + 用户 `~/.mewcode/hooks.yaml`（项目覆盖用户，同 index 合并）
- 校验：event/action 必需、action 字段完整（command 需 command、http 需 url、inject 需 content）；tool_before + async → 报错；坏规则跳过 + warn
- 返回 { rules, skipped }

### hook/runner.ts
- runCommandAction：spawn（Windows shell:true 复用）+ 10s 默认超时；输出 console.warn（调试级）
- runHttpAction：fetch（fire-and-forget）；失败 warn
- runInjectAction：返回 content（engine 缓冲）
- runSubagentAction：console.warn('[Hook] subagent 动作占位')

### hook/engine.ts
- fire：遍历该事件的规则 → once 检查（已 fired 跳过 + 标记）→ 条件匹配（data = ctx 展平：name/args/content/round）→ 动作执行
- async 动作：`void run()` 不 await（tool_before 校验已禁）
- intercept：tool_before 规则按顺序：命中第一条 → 返回 `[Hook 拦截] <规则描述>`；未命中 null
- collectInjections/resetRound：inject_prompt 缓冲（round_start 时收集，round_end 清）

## 模块交互

```
loop round 开始:
  await engine.fire('round_start', { round })
  const injections = engine.collectInjections()  // 本轮注入
  msgs = [...主 system, 环境, 轮次指令, ...injections 的 system, ...历史]

executeOne（权限之后）:
  const blocked = ctx.hooks ? await ctx.hooks.intercept(call, ctx.cwd) : null
  if (blocked) return { success: false, error: blocked }   // [Hook 拦截] 回灌

executeBatch 后: engine.fire('tool_after', { call })
round 结束: engine.fire('round_end'); engine.resetRound()
useStream send 结束: engine.fire('message', { message: 新消息 })
cli: app_start/session_start/session_end/app_exit
```

## 文件组织

```
D:\MewCode\
├── src/
│   ├── hook/
│   │   ├── types.ts
│   │   ├── matcher.ts
│   │   ├── loader.ts
│   │   ├── runner.ts
│   │   └── engine.ts
│   ├── agent/loop.ts     — round/tool 挂钩
│   ├── tui/useStream.ts  — message 事件
│   └── cli.tsx           — 加载 + 生命周期事件
├── test/hook_test.ts     — 加载/匹配/触发/拦截/动作/控制/隔离
└── docs/phase11/         — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 注入 | engine 缓冲 → 每轮 msgs 加 system | 用户决策 |
| 拦截 | 权限后 + [Hook 拦截] 回灌 | 用户决策 |
| HTTP | fire-and-forget | 用户决策 |
| 命令超时 | 10s 默认 | 用户决策 |
| once | 会话内存 fired 标记 | 不做持久化 |
| async | 不 await；tool_before 禁 | 拦截语义 |
| 失败 | try/catch + warn | 不中断主流程 |
| 条件匹配 | matcher 复用权限语法 | 统一心智 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 三要素 + 校验 | loader.ts |
| F2 事件 | engine.fire + loop/useStream/cli 挂钩 |
| F3 tool_before 拦截 | engine.intercept + executeOne |
| F4 条件语法 | matcher.ts |
| F5 四动作 | runner.ts |
| F6 执行控制 | engine（once/async/timeout + 校验） |
| F7 失败隔离 | runner/engine try/catch |
| N1/N2/N3 | 同上 |
