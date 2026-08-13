# MewCode Phase7 Plan — 上下文管理

## 架构概览

新增 `context/` 层，两个挂钩点：工具结果回灌时立即存盘（轻量预防），每轮 API 请求前检查并摘要（重量兜底）。

```
工具结果产生（loop executeBatch）
  → spill（>4KB 单条 / 批次合计 >8KB）→ tool 消息留预览+路径
每轮请求前（loop beforeRequest）
  → TokenEstimator 估算总量
  → 超 window - margin → summarize（LLM 非流式，无工具）
      → history.replaceRange（早期消息 → 摘要 system 消息 + 边界消息）
      → 失败计数 ≥3 → 熔断
请求后（afterRequest）
  → 更新估算锚点（usage.inputTokens）
```

依赖方向：context → provider/history/tools 类型；loop → context；tui → context（/compact + 锚点）。无环。

## 核心数据结构

### ChatMessage role 扩展
```ts
// 摘要消息与边界消息用 role: 'system'（OpenAI 多 system 消息支持）
// 摘要消息内容格式: 「以下为早期对话摘要（<日期>）：\n<摘要文本>」
// 边界消息内容: 「部分早期对话已摘要。如需文件/代码细节，请重新调用工具读取，不要凭摘要推测内容。」
```

### TokenEstimator
```ts
class TokenEstimator {
  private anchorTokens = 0       // 上次 API input tokens
  private anchorCount = 0        // 锚点时的消息条数

  estimate(messages: ChatMessage[]): number
  // 有锚点: anchorTokens + Σ(锚点后新消息 字符数/4)
  // 无锚点: Σ(全部消息 字符数/4)
  update(usageInputTokens: number, messageCount: number): void
}
```

### 存盘
```ts
const SPILL_THRESHOLD = 4096        // 单条 >4KB 存盘
const BATCH_THRESHOLD = 8192        // 同批合计 >8KB 挑大存盘
const PREVIEW_LEN = 200

spillContent(content, dir): Promise<string>   // 写文件（时间戳命名），返回相对路径
spillBatch(results: {content}[]): Promise<{content: string}[]>  // 挑大依次存盘
// tool 消息替换格式: `[已存盘] ${preview}…\n完整内容: ${relPath}`
```

### 摘要
```ts
const SUMMARY_SYSTEM = `...禁止调用任何工具。先写分析草稿（仅供内部，不要输出），再输出正式摘要。摘要按以下五部分组织：
1. 任务目标 2. 已完成事项 3. 进行中事项 4. 关键决策 5. 文件与代码状态`

async function summarize(provider, earlyMessages: ChatMessage[], ctx): Promise<string>
// 独立 streamChat（thinking false，无 tools），收集全文；失败 throw

function tailKeep(messages, keepTokens = 10000, minCount = 5): { keep: ChatMessage[]; drop: ChatMessage[] }
// 从尾部往回：token 累加（字符/4）至 keepTokens，且至少 minCount 条
```

### ContextManager
```ts
class ContextManager {
  constructor(opts: {
    provider, history, spillDir, window: number,
    autoMargin?: number   // 13000
    manualMargin?: number // 3000
  })

  async beforeRequest(mode: 'auto' | 'manual'): Promise<void>
  // ① 检查历史中未存盘的大 tool 消息 → spill 替换
  // ② estimator.estimate(history) > window - margin
  //    → summarize(早期 drop 部分) → history.replaceRange → 插边界消息
  //    → 摘要失败 failCount++（≥3 熔断，会话内自动模式不再触发）
  // 手动模式绕过熔断

  afterRequest(usageInputTokens: number, messageCount: number): void
  get breakerOpen(): boolean
  get lastSummary(): string | null
}
```

## 模块设计

### context/estimate.ts
TokenEstimator 如上。字符/4 估算（中文约 1.5 字符/token，保守按 4 偏大，留余量安全）。

### context/spill.ts
- 路径：`<cwd>/.mewcode/artifacts/spill_<timestamp>_<n>.txt`
- mkdir recursive；返回相对 cwd 路径（对话内展示）+ 绝对路径（内部用）
- `spillBatch`：结果按大小降序处理，直到剩余合计 ≤ BATCH_THRESHOLD

### context/summary.ts
- SUMMARY_SYSTEM + BOUNDARY_MESSAGE 常量
- summarize：构造 messages = [system(SUMMARY_SYSTEM), ...earlyMessages] → provider.streamChat 收集 → 返回文本
- 超时/错误 → throw

### context/manager.ts
- beforeRequest：spill 检查（扫描 history 中 tool 消息，content 长度 >4KB 且未含 [已存盘] → 替换）+ 估算 + 摘要
- 摘要后 replaceRange(0, drop.length, [摘要消息, 边界消息])
- 熔断：failCount ≥3 → breakerOpen = true；手动模式继续尝试但失败计数照记（手动成功清零？设计：成功清零 failCount）

### session/history.ts（扩展）
```ts
replaceRange(start: number, end: number, messages: ChatMessage[]): void
```

### agent/loop.ts（挂钩）
- executeBatch 结果回灌前：`ctx.spill` 存在时对 results 做 spillBatch（返回处理后的 content）
- 每轮 streamChat 前：`ctx.beforeRequest?.('auto')`
- 请求后：`ctx.afterRequest?.(usageInputTokens, history.length)`

### ToolContext 扩展
```ts
spill?: (results: { content: string }[]) => Promise<{ content: string }[]>   // 存盘处理
beforeRequest?: (mode: 'auto' | 'manual') => Promise<void>
afterRequest?: (usageInputTokens: number, messageCount: number) => void
```

### tui（接入）
- useStream：创建 ContextManager（window 从 config 读，默认 131072）；ctx 注入 loop 挂钩
- App：`/compact` → manager.beforeRequest('manual')（提示「压缩完成/失败」）

### config
- config.yaml 加 `context_window`（可选，默认 131072）；loader 解析进 ProviderConfig

## 文件组织

```
D:\MewCode\
├── src/
│   ├── context/
│   │   ├── estimate.ts
│   │   ├── spill.ts
│   │   ├── summary.ts
│   │   ├── manager.ts
│   │   └── index.ts
│   ├── session/history.ts    — replaceRange
│   ├── tools/types.ts        — ToolContext 扩展
│   ├── agent/loop.ts         — spill/请求前/请求后挂钩
│   ├── tui/{useStream,App}.tsx — manager + /compact
│   └── config/{types,loader}.ts — context_window
├── test/context_test.ts      — 估算/存盘/摘要/触发/熔断/边界/保留
└── docs/phase7/              — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 存盘时机 | 结果产生时立即（loop 回灌前） | 更早释放，请求前检查只做兜底扫描 |
| 摘要时机 | 请求前（loop beforeRequest） | spec F7 |
| 摘要/边界 role | system | 不污染对话语义，OpenAI 支持多 system |
| 估算 | 锚点 + 增量字符/4 | 用户决策（无精确 tokenizer） |
| 熔断 | failCount ≥3 会话内停自动；成功清零 | 用户决策 |
| 窗口 | config context_window 默认 131072 | 用户决策 |
| 摘要后端 | 复用 provider 非流式 | 用户决策 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 存盘 | context/spill.ts + loop 挂钩 |
| F2 LLM 摘要 | context/summary.ts + manager |
| F3 摘要 Prompt | summary.ts SUMMARY_SYSTEM |
| F4 边界消息 | summary.ts BOUNDARY_MESSAGE + manager |
| F5 手动/熔断 | manager beforeRequest('manual') + breaker |
| F6 近似估算 | context/estimate.ts |
| F7 触发时机 | loop 挂钩 + 用户消息不摘要（tailKeep 从尾部保留） |
| N1 不中断轮次 | beforeRequest 同步完成 |
| N2 存盘可读 | utf8 文本文件 |
| N3 摘要独立 | summarize 独立调用不进 history |
