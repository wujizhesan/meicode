# MewCode Phase4 Plan — 系统提示工程

## 架构概览

P3 的单块 `prompt.ts` 重构为 `prompt/` 目录：模块注册表拼装主 system 消息（缓存前缀），环境与轮次指令以独立 system 消息注入。runAgent 的消息组装变为三段式：

```
messages = [主 system（稳定模块，缓存前缀）] + [环境 system（cwd/日期）] + [轮次指令 system（会话开关，full/slim）] + 历史
```

依赖：tui/agent → prompt/（纯函数，无外部依赖）；provider 解析 cache 字段供 UI 显示。

## 核心数据结构

### PromptModule（模块注册表）
```ts
interface PromptModule {
  id: string        // 'identity' | 'constraints' | 'task-mode' | 'actions' | 'tools' | 'tone' | 'output'
  priority: number  // 1-7，越小越靠前
  content: string
}
```

### StreamEvent.usage 扩展（cache 字段可选）
```ts
| { type: 'usage'; inputTokens: number; outputTokens: number
    cacheHitTokens?: number; cacheMissTokens?: number }   // DeepSeek 特有，兼容缺失
```

### 轮次注入策略
```ts
// prompt/injection.ts
sessionDirective(mode: 'plan' | 'full', round: number): string | null
// round === 1 或 round % 3 === 1 → 全量指令
// 否则 → 精简指令（仅关键句）
// 模式切换天然全量：每次 runAgent 是独立调用，round 从 1 开始
```

## 模块设计

### prompt/modules.ts
七个模块常量（含 P3 全部现有规则，按职责拆分）：
| id | priority | 内容 |
|----|----------|------|
| identity | 1 | 你是 MewCode，终端 AI 助手 |
| constraints | 2 | 系统约束（失败不崩、结构化结果等） |
| task-mode | 3 | 任务模式说明（/plan /do 语义） |
| actions | 4 | 动作执行规则（编辑前必先读、失败调整重试） |
| tools | 5 | 工具使用规则（优先专用工具、最少调用） |
| tone | 6 | 语气风格（简洁、直接） |
| output | 7 | 文本输出（基于工具结果、中文回答） |

### prompt/rules.ts（双重强化单一来源）
```ts
export const KEY_RULES = {
  preferTools: '优先使用专用工具：能调用工具完成的任务必须调用工具，不要声称做不到',
  readBeforeEdit: '编辑文件前必须先读取该文件，确认上下文',
  retryOnFailure: '工具执行失败时，根据错误信息调整参数重试，或如实报告失败原因',
}
```
工具 description 与系统提示模块同时引用这些语义（工具侧在 P4 中核对/增强措辞）。

### prompt/environment.ts
```ts
buildEnvironmentInfo(ctx: ToolContext): string
// '当前工作目录：<cwd>\n当前日期：<YYYY-MM-DD>'
```

### prompt/index.ts
```ts
buildSystemPrompt(mode: 'plan' | 'full'): string
// MODULES.sort(priority).map(content).join('\n\n')
// 保留 buildPrompt 兼容签名（P3 调用方改用新函数）
```

### agent/loop.ts（改造消息组装）
```
每轮：
  messages = [
    { role: 'system', content: buildSystemPrompt(mode) },      // 稳定前缀
    { role: 'system', content: buildEnvironmentInfo(ctx) },    // 环境（变化）
    { role: 'system', content: sessionDirective(mode, round) }, // 轮次指令（full/slim/null）
    ...history.all(),
  ]
```
- sessionDirective 返回 null 时跳过该消息（轮次间不注入）
- 主 system 消息每轮字节一致（AC2）

### provider/openai.ts（cache 字段解析）
- usage chunk 解析加：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（字段名真机确认，缺失则 undefined）
- 存入 usage 事件的可选字段

### tui/useStream.ts（命中率显示）
- 累计 cacheHit/cacheMiss → 状态行显示 `缓存命中 X%`

## 模块交互

```
runAgent 每轮:
  buildSystemPrompt(mode) ──→ 主 system（缓存前缀，逐字节稳定）
  buildEnvironmentInfo(ctx) ──→ 环境 system
  sessionDirective(mode, round) ──→ 轮次 system（round 1/4/7 全量）
  ──→ provider.streamChat → usage 事件（含 cache 字段）→ UI 命中率
```

## 文件组织

```
D:\MewCode\
├── src/
│   ├── agent/
│   │   ├── prompt/               — 新目录（替代 prompt.ts）
│   │   │   ├── index.ts          — buildSystemPrompt + 注册表
│   │   │   ├── modules.ts        — 七模块
│   │   │   ├── rules.ts          — 关键规则（双重强化）
│   │   │   ├── environment.ts    — 环境信息
│   │   │   └── injection.ts      — 轮次注入策略
│   │   ├── loop.ts               — 三段式消息组装
│   │   └── events.ts             — 不变
│   ├── provider/
│   │   ├── types.ts              — usage 事件加 cache 字段
│   │   └── openai.ts             — cache 字段解析
│   ├── tools/*.ts                — 核对/增强 description（双重强化）
│   └── tui/useStream.ts          — 缓存命中率状态
├── test/
│   ├── loop_test.ts              — 加：前缀稳定/轮次注入/环境分流断言
│   └── live_probe.ts             — 真机确认 cache 字段名
└── docs/phase4/
    ├── spec.md / plan.md / task.md / checklist.md
    └── cache_eval.md             — 人工对比评估记录（AC6）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 模块结构 | 常量数组 + priority 排序 | 可插拔（N2） |
| 环境信息 | 独立 system 消息（末尾） | 不破坏缓存前缀（AC2/AC3） |
| 轮次注入 | runAgent 内 round 驱动 | 每次 runAgent 独立 → 模式切换天然首轮全量 |
| 注入频率 | round % 3 === 1 全量，否则精简 | 用户决策 |
| cache 字段 | usage 可选字段 | 兼容无缓存数据的端点 |
| 双重强化 | rules.ts 单一来源，工具描述对齐措辞 | 一处维护两处生效 |
| 旧 buildPrompt | 保留兼容签名，内部调新模块 | P3 调用方平滑迁移 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 模块化 | prompt/modules.ts + index.ts |
| F2 稳定/变化分离 | loop.ts 三段式组装 |
| F3 双重强化 | prompt/rules.ts + 工具 description |
| F4 补充指令注入 | 独立 system 消息（环境 + 轮次） |
| F5 轮次注入 | prompt/injection.ts |
| F6 缓存验证 | openai.ts cache 字段 + useStream 命中率 + cache_eval.md |
| N1 前缀稳定 | 主 system 不混轮次内容（组装分离） |
| N2 可插拔 | 注册表数组 |
| N3 P3 兼容 | buildPrompt 兼容签名 + 回归测试 |
| N4 无回归 | AC7 |
