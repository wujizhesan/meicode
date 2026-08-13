# MewCode Phase9 Plan — 命令系统

## 架构概览

新增 `commands/` 层：注册中心 + 解析器 + 十内置命令 + 分流器。App 的回车入口统一走 dispatcher；命令通过 UiController 接口操作（App 实现，包 useStream 能力），与渲染框架解耦。

```
用户回车
  → dispatcher.dispatch(input)
      ├─ 斜杠 → registry.find(parse) → handler(args, ui)   （本地执行，不进对话）
      │          ├─ 未命中 → showMessage('/help 引导')
      │          └─ prompt 类 → ui.sendUserMessage(预设文本)
      └─ 非斜杠 → 返回 false → stream.send（正常对话）
Tab 键（Input 内捕获）
  → registry.complete(prefix) → 单匹配补全 / 多匹配菜单
```

依赖：commands → types（自包含）；tui → commands。无环。

## 核心数据结构

### CommandDef 与 UiController
```ts
type CommandType = 'local' | 'ui' | 'prompt'

interface CommandDef {
  name: string
  aliases?: string[]
  description: string
  usage: string
  type: CommandType
  paramHint?: string
  hidden?: boolean
  handler: (args: string[], ui: UiController) => void | Promise<void>
}

interface UiController {
  showMessage(text: string): void                        // 界面显示提示
  sendUserMessage(text: string): void                    // prompt 类：送对话
  setMode(mode: UserMode): void                          // 模式切换（状态栏联动）
  clearHistory(): void                                   // /clear
  compact(): Promise<string>                             // /compact 结果文本
  sessionAction(action: 'list' | 'resume' | 'new', arg?: string): string
  memoryList(): string
  permissionSummary(): string
  getStatus(): string                                    // 模式/token/缓存/会话 格式化文本
}
```

### 解析结果
```ts
interface ParsedCommand { name: string; args: string[] } | null
// null = 非命令（走对话）；'/HELP x' → { name: 'help', args: ['x'] }
```

## 模块设计

### commands/types.ts
CommandType / CommandDef / UiController / ParsedCommand。

### commands/registry.ts
```ts
class CommandRegistry {
  private byName = new Map<string, CommandDef>()   // canonical name → def
  private byAlias = new Map<string, string>()      // name/alias → canonical

  register(cmd: CommandDef): void
  // 冲突（name 或 alias 与已有重名）→ throw Error（cli 启动 catch → 打印 + exit 1）
  find(name: string): CommandDef | undefined       // 小写查找
  list(includeHidden = false): CommandDef[]
  complete(prefix: string): string[]               // 补全候选（hidden 排除）
}
```

### commands/parser.ts
```ts
parseCommandLine(input: string): ParsedCommand
// 非 '/' 开头 → null；纯 '/' 或空白 → null（早返回）
// '/name args' → 第一个空格前 name（转小写），之后 split(/\s+/) 参数
```

### commands/builtin.ts（十命令）
| 命令 | type | handler 行为 |
|------|------|-------------|
| help | local | 遍历 list() 格式化 name+usage+description |
| compact | local | ui.compact() → showMessage |
| clear | local | ui.clearHistory() → showMessage('已清空对话历史（存档保留）') |
| plan | ui | ui.setMode('plan')；args[0] → ui.sendUserMessage(args.join(' ')) |
| do | ui | ui.setMode('default') → showMessage('已退回默认模式') |
| session | local | ui.sessionAction('list'/'resume'/'new', arg)；aliases: ['resume'] |
| memory | local | ui.memoryList() → showMessage |
| permission | local | ui.permissionSummary() → showMessage |
| status | local | ui.getStatus() → showMessage |
| review | prompt | ui.sendUserMessage('请审查最近的 git 变更：运行 git diff 查看改动，指出问题、风险与改进建议，按严重程度排序') |

### commands/index.ts
```ts
function createDispatcher(registry: CommandRegistry, ui: UiController): {
  dispatch(input: string): boolean   // true=已处理（斜杠命令）；false=走对话
  complete(prefix: string): string[] // Tab 补全候选
}
// dispatch: parse → null → false；find → handler；未找到 → showMessage 未知命令 + /help 引导 → true
```

## 模块交互

```
App.handleSend(text):
  if (dispatcher.dispatch(text)) return   // 命令已处理
  stream.send(text)                        // 非命令走对话

Input 组件（Tab 键捕获）:
  useInput(tab) → onTabComplete(value) → dispatcher.complete
    单匹配 → 直接补全（setValue）
    多匹配 → App 显示候选菜单（方向键/回车选择，Esc 关闭）

App 的 UiController 实现:
  showMessage → setCompactMsg（界面提示行）
  sendUserMessage → stream.send(text)（pushUser: true）
  setMode → stream.setUserMode
  clearHistory → history.clear() + stream 清 messages
  compact → stream.compact()
  sessionAction → stream.resume/listSessions/newSession
  memoryList → 读 memory 目录列表
  permissionSummary → 当前模式 + 规则文件路径
  getStatus → 模式/token/缓存/会话 格式化
```

## 文件组织

```
D:\MewCode\
├── src/
│   ├── commands/
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── parser.ts
│   │   ├── builtin.ts
│   │   └── index.ts
│   ├── tui/App.tsx       — handleSend 分流 + UiController 实现 + 补全菜单
│   ├── tui/Input.tsx     — Tab 捕获
│   ├── tui/useStream.ts  — 暴露 clearHistory/newSession 等方法
│   └── cli.tsx           — registry 构造 + 冲突 catch exit
├── test/commands_test.ts — 注册/解析/分发/补全/十命令
└── docs/phase9/          — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 冲突处理 | register throw → cli catch 打印 + exit 1 | fail-fast（spec N2） |
| Tab 补全 | Input 内捕获 Tab（Ink 多 useInput 都收事件）+ App completeFn | 输入值在 Input state |
| 未命中 | showMessage「未知命令 /xxx，输入 /help」 | spec F2 |
| prompt 类 | sendUserMessage（走正常对话） | 复用 Agent 能力 |
| 模式标记 | UiController.setMode → stream.setUserMode → 状态栏自动联动 | 单一数据源 |
| /session | sessionAction 统一处理 list/resume/new | /resume 别名 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 注册中心 | registry.ts |
| F2 解析器 | parser.ts |
| F3 三类命令 | types.ts CommandType + builtin |
| F4 UiController | types.ts + App 实现 |
| F5 分流器 | index.ts dispatcher + App.handleSend |
| F6 Tab 补全 | registry.complete + Input/App |
| F7 十命令 | builtin.ts |
| N1 不经过 LLM | local/ui 本地执行；prompt 仅触发一次 send |
| N2 启动即爆 | registry throw + cli catch |
| N3 补全不打断 | Tab 后 value 可继续编辑 |
