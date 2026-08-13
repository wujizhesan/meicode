# MewCode Phase3 Plan — Agent Loop

## 架构概览

P2 的 `runToolLoop`（2 轮硬编码）升级为 `runAgent`：真正的 ReAct 循环，对外暴露**事件流 handle**，UI 通过事件映射完全解耦。

```
用户提问 / /plan / /do
    ↓
App（模式状态 + Ctrl+C 语义）
    ↓
useStream（AgentEvent → setState 映射，纯 UI 壳）
    ↓ 创建
runAgent（Agent 核心，无 React 依赖，可独立测试）
    ├─ 每轮：provider.streamChat（双路：onEvent 实时推 + 内部攒完整响应）
    ├─ 停止条件检查（五类）
    ├─ 多工具分批执行（读并发/写串行）
    └─ 事件：text / tool_call / tool_result / usage / progress / done
```

依赖方向：tui → agent → provider/tools。agent 层是纯逻辑（不 import React/Ink）。

## 核心数据结构

### AgentEvent（事件流，UI 唯一数据源）
```ts
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; success: boolean; summary: string }
  | { type: 'usage'; round: number; inputTokens: number; outputTokens: number }
  | { type: 'progress'; round: number; max: number; status: string }
  | { type: 'done'; reason: StopReason; rounds: number; totalTokens: number }

type StopReason = 'complete' | 'max_iterations' | 'cancelled' | 'unknown_tool' | 'error'
```

### Agent 配置与句柄
```ts
interface AgentOptions {
  provider: Provider
  history: History
  registry: ToolRegistry
  ctx: ToolContext                      // confirm 已移除（自主执行）
  maxIterations: number                 // 15
  mode: 'plan' | 'full'                 // plan 只读工具
  systemPrompt: string
  planContext?: string                  // /do 时注入的计划文本
  unknownToolLimit: number              // 2
}

interface AgentHandle {
  events: AsyncIterable<AgentEvent>
  cancel(): void                        // 用户取消（Ctrl+C）
  done: Promise<AgentResult>            // 最终结果（供 send 收尾）
}

interface AgentResult {
  reason: StopReason
  rounds: number
  totalTokens: number
  finalText: string
}
```

### StreamEvent 扩展（provider 层）
```ts
| { type: 'usage'; inputTokens: number; outputTokens: number }   // OpenAI include_usage 的最终 chunk
```

## 模块设计

### agent/loop.ts（重写为 runAgent）
**职责：** ReAct 循环 + 停止条件 + 多工具分批。
**流程：**
```
runAgent(opts) → { events, cancel, done }
  循环 round = 1..maxIterations:
    if signal.aborted → done(cancelled)
    ① streamChat(history + system, {tools(按 mode 过滤), stream_options.include_usage})
       双路：onEvent(ev) 转发给 events；内部攒 roundText / roundCalls / usage
    ② usage 事件累计 totalTokens
    ③ roundCalls 为空 → 完成：push assistant 最终回复 → done(complete)
    ④ 未知工具连续计数：本轮全未知 → streak++；否则 streak=0
        streak >= limit → 回写「连续 N 次未知工具」错误 → done(unknown_tool)
    ⑤ push assistant(tool_calls) → 分批执行（见下）→ 结果回写 → round++
  超过 max → done(max_iterations)
  流 error 事件 → done(error)
```

**多工具分批执行：**
```ts
READ_TOOLS = { read_file, find_files, grep_code }   // 无副作用
WRITE_TOOLS = { write_file, edit_file, run_command } // 有副作用
executeBatch(calls):
  reads = calls.filter(读类)      // Promise.all 并发
  others = calls.filter(非读类)    // for 循环串行（含未知工具）
  结果按原始 calls 顺序合并回写 tool 消息
```

### agent/events.ts
AgentEvent / StopReason / AgentOptions / AgentHandle / AgentResult 类型（从 loop.ts 分离，供 tui 与测试导入）。

### agent/prompt.ts（扩展）
```ts
SYSTEM_PROMPT                // 全工具模式（P2 版）
PLAN_SYSTEM_PROMPT           // 计划模式：只读工具 + 输出计划格式（步骤列表）
buildPrompt(mode, planContext)  // /do 时追加「你已制定的计划：…，按计划执行」
```

### provider/openai.ts（小改）
1. 请求体加 `stream_options: { include_usage: true }`
2. 流式解析：`data.usage`（choices 为空数组的最终 chunk）→ yield `usage` 事件
3. 兼容性：真机冒烟若 DeepSeek 拒绝 include_usage（400）→ 去掉该字段（usage 事件空缺，不阻塞循环）

### tui/useStream.ts（重写为事件映射）
- `send(text)` → runAgent(...)，把 AgentEvent 逐条 setState：
  - text/thinking → 当前 assistant 占位追加
  - tool_call → 占位追加「🔧 调用工具」
  - tool_result → push tool 行（成功/失败摘要）
  - progress → 状态栏步数
  - usage → 累计 token 状态
  - done → 收尾（停止原因显示），history 已由 agent 维护
- `cancel()` 暴露给 App；`isRunning` 状态
- 模式切换：`setMode('plan'|'full')` 供 /plan /do 调用

### tui/App.tsx（改造）
- 输入识别：`/plan`、`/do` 前缀 → 模式切换（不发送给模型）；其他 → send
- Ctrl+C 语义：`isRunning` 时 → cancel()（不退出）；空闲时 → 二次确认退出或直接退出（保持 P2：直接 exit）
- 模式显示：`[Plan]` / `[Full]` 标记在输入行
- run_command 的 confirm 移除（ToolContext.confirm 不再传入，run_command 自主执行）

### tui/Input.tsx（小改）
提交时识别 /plan /do（App 处理，Input 只透传）。

## 模块交互

```
Input 提交:
  /plan → App.setMode('plan') → 提示「计划模式：仅读类工具」
  /do   → App.setMode('full') + 把已生成计划注入 planContext → send(原始问题)
  普通  → send(text)
send:
  runAgent({provider, history, registry, ctx, mode, systemPrompt, planContext, ...})
    → events 流 → useStream setState → 界面
    → done → 摘要显示（步数/原因/token）
Ctrl+C:
  isRunning ? cancel() : exit
```

## 文件组织

```
D:\MewCode\
├── src/
│   ├── agent/
│   │   ├── events.ts          — AgentEvent/StopReason/AgentOptions/AgentHandle/AgentResult（新）
│   │   ├── loop.ts            — 重写：runAgent + 分批执行
│   │   └── prompt.ts          — 扩展：PLAN_SYSTEM_PROMPT + buildPrompt
│   ├── provider/
│   │   ├── types.ts           — StreamEvent 加 usage
│   │   └── openai.ts          — include_usage 请求与解析
│   ├── tools/run_command.ts   — 移除 confirm 强制（无 confirm 也执行）
│   └── tui/
│       ├── useStream.ts       — 重写：事件映射 + cancel/isRunning/模式
│       ├── App.tsx            — /plan /do 识别 + Ctrl+C 语义 + 模式显示
│       └── Input.tsx          — 透传（无大改）
├── test/
│   ├── loop_test.ts           — 重写：五类停止条件 + 分批并发断言 + Plan Mode 断言
│   └── smoke.ts               — openai usage 解析测试
└── docs/phase3/               — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Agent 形态 | 纯函数 runAgent + 事件流 handle | 无 React 依赖，可独立测试（P2 教训：核心逻辑可测） |
| 取消机制 | AbortSignal（cancel() 触发） | 标准；Ctrl+C 不杀进程，等循环干净停止 |
| 并发边界 | 读类并发（Promise.all）/ 写类串行 | 安全 + 效率；写类并行有竞态风险 |
| usage 获取 | `stream_options.include_usage` | OpenAI 标准；真机冒烟验证 DeepSeek 兼容，失败则降级空缺 |
| 未知工具计数 | 连续计数，任一轮有合法工具即清零 | 模型可自纠，不误伤 |
| plan 上下文 | /do 时 system prompt 追加计划文本 | 简单有效，不引入额外状态 |
| /plan /do | TUI 输入前缀识别 | 用户指定形态 |
| run_command | 移除确认（ctx.confirm 不传） | 用户决策：自主执行，权限下章 |
| 真机冒烟 | T0 前置任务（AC9） | P2 教训：外部行为最先验证，不等验收 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 ReAct 循环 | agent/loop.ts runAgent 主循环 |
| F2 五类停止条件 | loop.ts 各检查点 + AbortSignal |
| F3 异步事件流 | agent/events.ts + runAgent 的 events 迭代器 |
| F4 双路收集器 | runAgent 内 onEvent 转发 + 内部攒完整响应 |
| F5 多工具分批 | executeBatch（读并发/写串行） |
| F6 Plan Mode | mode 字段 + prompt.ts + App /plan /do |
| F7 进度与用量 | progress/usage 事件 + useStream 状态 |
| N1 停止摘要 | done 事件含 reason/rounds/totalTokens |
| N2 资源不泄漏 | AbortSignal + reader 正常关闭 |
| N3 纯对话兼容 | 无 tool_calls 即单轮 complete |
| N4 自主执行 | run_command 去 confirm + 8KB 截断保留 |
| AC9 真机冒烟 | T0 任务（用户配合） |
