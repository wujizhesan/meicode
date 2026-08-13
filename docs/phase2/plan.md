# MewCode Phase2 Plan — 工具系统

## 架构概览

新增 `tools` 层（独立于现有五层），TUI 的会话 hook（useStream）扩展为单轮工具循环：

```
tui (确认弹窗) ──→ useStream（单轮循环）
                       │ 发送 tools 定义
                       ▼
                   provider（OpenAI 流式 + tool_calls 分片聚合）
                       │ 事件流（text / tool_call / done / error）
                       ▼
                   useStream：tool_call → registry.get → tool.execute(ctx)
                       │ 确认回调（run_command）
                       ▼
                   ToolResult → 转 tool 消息 → 回灌 history → 第二轮生成
```

依赖方向：tui → tools（registry 通过 useStream 注入）；tools → 无（纯 Node API）；provider 只认识中立工具定义（不依赖 registry）。

## 核心数据结构

### Tool / ToolResult / ToolContext
```ts
interface Tool {
  name: string
  description: string
  parameters: JsonSchema                // { type: 'object', properties: {...}, required: [...] }
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

interface ToolResult {
  success: boolean
  output: string                        // 文本结果（已截断）
  truncated?: boolean                   // 超过 8KB 截断时置 true
  error?: string                        // 失败时的人类可读信息
}

interface ToolContext {
  cwd: string                           // 启动时 cwd
  confirm?: (command: string) => Promise<boolean>   // run_command 确认（TUI 注入）
  timeoutMs?: number                    // 命令超时，默认 30000
}
```

### ChatMessage 扩展（工具消息）
```ts
interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; name: string; arguments: string }[]  // assistant 专用，OpenAI 格式
  tool_call_id?: string                 // tool 消息专用
}
```

### StreamEvent 扩展
```ts
type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }  // 新增
  | { type: 'done' }
  | { type: 'error'; message: string }
```

### Provider 接口扩展
```ts
interface Provider {
  streamChat(messages: ChatMessage[], opts: {
    thinking?: boolean
    tools?: { name: string; description: string; parameters: JsonSchema }[]  // 新增
  }): AsyncGenerator<StreamEvent>
}
```

## 模块设计

### tools/types.ts
Tool / ToolResult / ToolContext / JsonSchema 定义。JsonSchema 用最小手写结构（type/properties/required/description），不引入依赖。

### tools/registry.ts
```ts
class ToolRegistry {
  register(tool: Tool): void            // 重名抛错
  get(name: string): Tool | undefined
  toOpenAITools(): OpenAITool[]         // {type:'function', function:{name,description,parameters}}
  list(): Tool[]
}
```

### tools/read_file.ts
参数 `{ path }`。`fs.promises.readFile(join(cwd, path), 'utf8')`；超 8KB 截断 + truncated 标记；不存在/权限错 → 结构化错误。

### tools/write_file.ts
参数 `{ path, content }`。递归创建父目录（mkdir recursive）；写入 utf8；返回写入字节数。

### tools/edit_file.ts
参数 `{ path, old_text, new_text }`。读文件 → `split(old_text)` 计数：
- 0 处 → `error: '未找到原文片段'` + 提示检查转义/换行
- ≥2 处 → `error: '原文匹配到 N 处，需要更长的上下文'` + 首个匹配位置
- 恰 1 处 → 替换写回，返回变更前后摘要

### tools/run_command.ts
参数 `{ command, args?, timeout? }`。执行前调 `ctx.confirm(command)`——拒绝 → `{success:false, error:'用户拒绝执行命令'}`。
执行：`spawn(command, args ?? [], { cwd, shell: process.platform === 'win32' })`（Windows 无 shell 跑不了内置命令如 dir；命令内容已由用户确认，安全由确认环节兜底）。stdout/stderr 合并，超时 kill + `error: '命令超时'`；非零退出码 → 结构化错误含 exit code 与输出尾部。

### tools/find_files.ts
参数 `{ pattern, path? }`。基于 cwd（或给定 path）递归用 glob 匹配。优先 Node 24 内置 `fs.promises.glob`（零依赖），task 阶段验证可用性，不可用则装 `fast-glob`。排除 node_modules/.git。返回相对路径列表（最多 100 条 + 截断标注）。

### tools/grep_code.ts
参数 `{ pattern, path?, glob? }`。递归目录（排除 node_modules/.git），读文本文件逐行正则匹配，返回 `文件:行号: 行内容`（每文件最多 20 条，总数最多 200 条）。pattern 非法正则 → 结构化错误。

### tools/index.ts
`createTools(ctx: ToolContext): Tool[]`——实例化六个工具。registry 由 useStream 持有：`const registry = new ToolRegistry(); tools.forEach(t => registry.register(t))`。

### provider/openai.ts（改造）
1. 请求体：有 tools 时加 `tools` 字段（OpenAI 格式）
2. 流式解析：新增 `tool_calls` delta 聚合——按 `delta.tool_calls[i].index` 归组，拼接 `function.arguments` 碎片，`function.name`/`id` 首帧捕获；`[DONE]` 时对未完成分片尝试 JSON.parse——成功 → yield `tool_call` 事件；失败 → yield `error('工具参数解析失败: ...')`
3. 消息转换：assistant 消息带 `tool_calls` → OpenAI 格式（`content: null` + tool_calls 数组）；`role:'tool'` 消息 → `{role:'tool', tool_call_id, content}`
4. history 中若已有 tool_calls 的 assistant 消息，发送时还原原样（内容为 null，不能拼接文本）

### provider/anthropic.ts（不改造）
本阶段仅 OpenAI 协议支持工具（spec 决定）。Anthropic 收到带工具的历史消息时按原样透传文本（Phase2 不向 anthropic 发送 tools）。

### tui/useStream.ts（改造：单轮工具循环）
```ts
send(text):
  push user 消息 → setMode('streaming')
  round = 1
  loop:
    gen = provider.streamChat(history.all(), { tools })
    for await ev: text→渲染追加 / tool_call→缓存 / error→置错误
    done:
      if 无 tool_call:
        push assistant 消息（最终回复）→ 结束
      else if round == 1:
        push assistant 消息（含 tool_calls 元数据，content 为空）
        for each tool_call:
          tool = registry.get(name)   // 不存在 → 构造「未找到工具」tool 结果
          result = await tool.execute(args, ctx)   // ctx.confirm 由 App 注入
          push tool 消息 {tool_call_id, content: 序列化结果}
        round = 2 → 再次 streamChat
      else:
        // 第二轮又调工具 → 截断
        提示「本阶段暂不支持连环调用」，丢弃本轮 tool_call，保留已渲染文本
```

### tui/App.tsx（改造：确认弹窗）
新增状态 `pendingConfirm: { command: string; resolve: (ok: boolean) => void } | null`：
- 渲染：确认行「⚠ 执行命令: <command>（Enter 执行 / Esc 拒绝）」，禁用输入框
- useInput：Enter → resolve(true) 并清空；Esc → resolve(false)
- run_command 的 ctx.confirm 由 App 提供：`(cmd) => new Promise(res => setPendingConfirm({command: cmd, resolve: res}))`

## 模块交互

```
用户提问
  → useStream.send
  → provider.streamChat(history, {tools})    // 首次
  → 事件流：text 渲染（流式）；tool_call 缓存
  → done：
     无 tool_call → 最终回复，结束
     有 tool_call（第 1 轮）→ registry.get → tool.execute(ctx)
        run_command 时：ctx.confirm → App 弹确认 → Enter/Esc
     结果转 tool 消息回灌 history
  → provider.streamChat(history, {tools})    // 第二轮，生成最终回复
  → 若第二轮仍有 tool_call → 截断 + 提示
```

## 文件组织

```
D:\MewCode\
├── src/
│   ├── tools/
│   │   ├── types.ts          — Tool/ToolResult/ToolContext/JsonSchema
│   │   ├── registry.ts       — ToolRegistry
│   │   ├── index.ts          — createTools(ctx)
│   │   ├── read_file.ts
│   │   ├── write_file.ts
│   │   ├── edit_file.ts
│   │   ├── run_command.ts
│   │   ├── find_files.ts
│   │   └── grep_code.ts
│   ├── provider/
│   │   ├── types.ts          — 改：StreamEvent.tool_call、ChatMessage 扩展、Provider.tools
│   │   └── openai.ts         — 改：tools 请求、tool_calls 分片聚合、消息转换
│   ├── session/history.ts    — 改：透传扩展字段（push 不做字段过滤）
│   └── tui/
│       ├── useStream.ts      — 改：单轮工具循环
│       └── App.tsx           — 改：确认弹窗
├── test/
│   ├── smoke.ts              — 加：六工具直调、registry、edit 匹配规则、流式分片聚合
│   └── tui_smoke.tsx         — 加：确认弹窗渲染（TTY 下）
└── docs/phase2/              — spec.md / plan.md / task.md / checklist.md
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 工具调用协议 | 仅 OpenAI（DeepSeek 在用） | spec 决定；Anthropic 下章 |
| 命令执行 | `spawn` + Windows 下 `shell:true` | 无 shell 跑不了 dir 等内置命令；确认机制兜底安全 |
| 命令确认 | TUI 内联确认行（Enter/Esc） | 不离开主界面，符合终端工具惯例 |
| glob | 优先 Node 24 内置 `fs.promises.glob`，不可用装 fast-glob | 零依赖优先 |
| JSON Schema | 最小手写类型（不引入 zod/ajv） | 六工具参数简单，YAGNI |
| 结果截断 | 8KB 统一截断 + truncated 标记 | 防上下文爆炸 |
| tool_calls 聚合 | index 归组 + arguments 字符串拼接 + 结束 JSON.parse | OpenAI 分片协议标准做法 |
| 第二轮再调工具 | 截断 + 提示 | spec F6，Agent Loop 下章 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 Tool 接口 | tools/types.ts |
| F2 六核心工具 | tools/{read_file,write_file,edit_file,run_command,find_files,grep_code}.ts |
| F3 注册中心 | tools/registry.ts + toOpenAITools |
| F4 执行保障 | 各工具 execute + run_command 超时 + ToolResult 结构化 |
| F5 流式工具调用解析 | openai.ts tool_calls 聚合 |
| F6 单轮工具循环 | useStream 循环 + 截断提示 |
| F7 改文件规则 | edit_file.ts 唯一匹配 |
| F8 命令确认 | run_command ctx.confirm + App 确认弹窗 |
| F9 工作目录 | ToolContext.cwd（启动时注入） |
| N1 结果截断 | 各工具 8KB 截断 |
| N2 失败不崩 | 所有工具 try/catch → ToolResult |
| N3 执行安全 | spawn 参数形式 + 确认不可绕过 |
| N4 兼容 Phase1 | tools 可选项，不带时行为不变 |
