# MewCode Plan

## 架构概览

五层模块，单向依赖（cli → tui / provider / config，tui → provider / session，provider → config 类型）：

- **cli** —— 入口层：解析参数、加载配置、创建 Provider、挂载 Ink 应用
- **config** —— 配置层：YAML 加载 + 字段校验，产出类型化的 ProviderConfig
- **provider** —— Provider 层：统一接口 + Anthropic/OpenAI 实现 + 工厂
- **session** —— 会话层：对话历史容器（全历史），消息追加与读取
- **tui** —— 界面层：Ink 组件，输入框 + 消息列表 + 流式渲染

## 核心数据结构

### ChatMessage
```ts
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
```
统一对话消息。不含 system——第一版无 system prompt（YAGNI，spec 未要求）。

### ProviderConfig（YAML 六字段映射）
```ts
interface ProviderConfig {
  name: string
  protocol: 'anthropic' | 'openai'
  model: string
  base_url: string
  api_key: string
  thinking?: boolean   // 默认 false
}
```

### StreamEvent（Provider 流式事件的统一形态）
```ts
type StreamEvent =
  | { type: 'text'; text: string }          // 正文增量
  | { type: 'thinking'; text: string }      // 思考增量（仅 anthropic）
  | { type: 'done' }                        // 流结束
  | { type: 'error'; message: string }      // 流中断
```

### Provider 接口
```ts
interface Provider {
  readonly protocol: 'anthropic' | 'openai'
  streamChat(messages: ChatMessage[], opts: { thinking?: boolean }): AsyncGenerator<StreamEvent>
}
```
统一入口：收历史数组，吐流式事件。TUI 只管消费 StreamEvent，不感知后端差异。

## 模块设计

### cli（src/cli.ts）
**职责：** 进程入口。解析 `--config` 参数 → 加载配置 → 校验 → 工厂建 Provider → 渲染 Ink 应用。
**对外接口：** `main()`（幂等，可测试）
**依赖：** config.loader、provider.factory、tui.App

### config（src/config/）
**loader.ts** —— `loadConfig(path?): ProviderConfig`
- 默认路径 `~/.mewcode/config.yaml`，`--config` 覆盖
- 用 `yaml` 包解析；缺失字段、非法 protocol、空 api_key 抛带字段名的错误
**types.ts** —— ProviderConfig 定义

### provider（src/provider/）
**types.ts** —— ChatMessage / StreamEvent / Provider 接口
**index.ts** —— `createProvider(cfg: ProviderConfig): Provider`
- 按 protocol 分派，未知 protocol 抛错
**anthropic.ts** —— Anthropic Messages API
- 请求：`POST {base_url}/v1/messages`，`anthropic-version` 头，`x-api-key` 认证
- 流式：`stream: true` + SSE 事件归一化为 StreamEvent
  - `content_block_delta.text_delta` → text
  - `content_block_delta.thinking_delta` → thinking（thinking 开关时）
- 历史转换：ChatMessage → Anthropic messages 格式（最后一条 user 消息转成 user turn）
**openai.ts** —— OpenAI Chat Completions API
- 请求：`POST {base_url}/v1/chat/completions`，`Authorization: Bearer` 认证
- 流式：`stream: true` + SSE `choices[0].delta.content` → text

### session（src/session/history.ts）
**职责：** 对话历史容器。
**接口：** `push(msg)`, `all(): ChatMessage[]`, `clear()`
**说明：** 纯内存，全历史返回，无截断（spec 决定）。

### tui（src/tui/）
**App.tsx** —— Ink 根组件：状态机（idle / streaming / error），持有 messages 渲染列表
**ChatView.tsx** —— 消息列表渲染：user 消息与 assistant 消息分区；thinking 增量以暗色区块单独渲染，不与正文混排
**Input.tsx** —— `ink-text-input` 输入框；回车发送，streaming 期间禁用
**useStream.ts** —— hook：消费 AsyncGenerator，逐事件更新本地状态（正文追加、thinking 追加、done/error 收尾）

## 模块交互

```
用户回车
  ↓
Input.tsx ── 回调 → App.tsx
  ├─ history.push(user)
  ├─ createProvider 实例（cli 启动时注入）.streamChat(history.all(), {thinking})
  ├─ useStream 逐事件：
  │   ├─ text → 追加正文渲染（逐字出现）
  │   ├─ thinking → 追加暗色思考区
  │   ├─ error → 渲染错误行
  │   └─ done → 结束 streaming
  ├─ history.push(assistant, 完整回复)
  └─ 回到可输入态
```

数据流单向：Input → App 状态 → ChatView 渲染。Provider 对 TUI 无感知。

## 文件组织

```
D:\MewCode\
├── package.json          — type: module，scripts
├── tsconfig.json         — erasable-syntax-only 约束
├── config.example.yaml   — 六字段示例配置
├── src/
│   ├── cli.ts            — 入口 main()
│   ├── config/
│   │   ├── types.ts      — ProviderConfig
│   │   └── loader.ts     — YAML 加载与校验
│   ├── provider/
│   │   ├── types.ts      — ChatMessage/StreamEvent/Provider
│   │   ├── index.ts      — createProvider 工厂
│   │   ├── anthropic.ts  — Claude 实现
│   │   └── openai.ts     — OpenAI 实现
│   ├── session/
│   │   └── history.ts    — 历史容器
│   └── tui/
│       ├── App.tsx       — 根组件 + 状态机
│       ├── ChatView.tsx  — 消息列表渲染
│       ├── Input.tsx     — 输入框
│       └── useStream.ts  — 流消费 hook
└── spec.md / plan.md / task.md / checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| YAML 解析 | `yaml` npm 包 | 现代维护活跃，TS 类型完善 |
| SSE 解析 | `eventsource-parser` npm 包 | 成熟 0 依赖，手写易漏 CRLF/多行 data 边界 |
| UI 组件 | `ink` v5 + `ink-text-input` | Claude Code 同栈，React 心智模型 |
| 原生 TS 约束 | 只用 erasable 语法（禁 enum/参数属性），import 带 `.ts` 扩展名 | Node 24 type stripping 要求 |
| 模块格式 | ESM（package.json type: module） | Node 24 原生 TS + Ink v5 均为 ESM 优先 |
| 配置路径 | `~/.mewcode/config.yaml`，`--config` 覆盖 | 终端工具惯例，跨项目共享 |
| thinking 渲染 | 独立暗色区块，不混入正文 | 可读性 + AC5 完整呈现 |
| Provider 认证 | anthropic: x-api-key 头；openai: Bearer 头 | 各自官方规范 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 启动入口 | cli.main() + config.loader 校验 |
| F2 对话界面流式 | tui/ 四组件 + useStream |
| F3 多轮对话 | session.history 全历史传递 |
| F4 配置加载 | config/loader.ts 六字段校验 |
| F5 Provider 抽象 | provider/types.ts + index.ts 工厂 |
| F6 Anthropic + thinking | anthropic.ts 双 delta 归一化 |
| F7 OpenAI | openai.ts |
| N1 首 token 即渲染 | useStream 逐事件更新 |
| N2 Ctrl+C 退出 | Ink 默认 + 流中断兜底（error 事件） |
| N3 密钥安全 | api_key 仅内存使用，无日志 |
| N4 零构建 | Node 24 原生 TS + erasable 语法约束 |
