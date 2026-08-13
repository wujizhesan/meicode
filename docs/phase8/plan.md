# MewCode Phase8 Plan — 记忆系统

## 架构概览

新增 `memory/` 层三模块：指令加载、会话存档、自动笔记。启动初始化（清理+恢复），运行时挂钩（send 后存档、请求前注入指令+索引、自然停后异步笔记）。

```
cli 启动
  → SessionStore.cleanup()（30 天清理）
  → SessionStore.recoverLatest() → 填充 history（坏行跳过/截断/时间提醒）
  → loadInstructions(cwd) → 指令文本
  → useStream:
      send 前: systemPrompt = buildPrompt() + 指令 + 笔记索引（主 system 尾部）
      send 结束: diff 本轮新消息 → SessionStore.append（JSONL 追加）
      done 自然停: fire-and-forget updateNotes（异步 LLM，不阻塞）
```

依赖方向：memory → provider/history 类型；tui → memory。无环。

## 核心数据结构

### 会话存档
```ts
class SessionStore {
  constructor(dir: string)            // <cwd>/.mewcode/sessions
  append(messages: ChatMessage[]): void        // JSONL 追加（每行一个消息 JSON）
  recoverLatest(): { id: string; messages: ChatMessage[] } | null
  // 最新文件 → 逐行 parse（坏行跳过）→ 工具调用无结果截断 → 返回
  cleanup(olderThanDays = 30): number          // 删过期，返回删除数
  latestId(): string | null                    // 文件名扫描（不维护 meta）
}
function newSessionId(): string  // YYYYMMDD-HHMMSS-xxxx
```

### 指令加载
```ts
interface InstructionSource { priority: number; path: string }
// 优先级：项目根(3) > 项目 .mewcode(2) > 用户 ~/.mewcode(1)——拼接高优先级在前
async function loadInstructions(cwd: string): Promise<string>
// @include <path>：递归展开
//   visited 集合防环；深度 ≤5；路径 resolve 后必须落在 cwd 内（越界跳过+提示）
```

### 自动笔记
```ts
type NoteCategory = 'user_pref' | 'correction' | 'project_knowledge' | 'reference'

interface NoteUpdate { category: NoteCategory; title: string; content: string; action: 'create' | 'update' }

async function updateNotes(provider, recentMessages: ChatMessage[], opts: {
  userDir: string   // ~/.mewcode/memory
  projectDir: string // <cwd>/.mewcode/memory
}): Promise<void>
// LLM 输入：现有索引摘要 + 最近一轮对话 → 输出 JSON 笔记更新列表
// 写文件：frontmatter（category/date/title）+ 正文；action=update 时更新同名
// 索引：扫目录 → index.md（≤200 行/25KB）

function buildNotesIndex(userDir, projectDir): string  // 请求前注入用（读文件，快）
```

## 模块设计

### memory/instructions.ts
- 三层路径：`<cwd>/instructions.md`、`<cwd>/.mewcode/instructions.md`、`~/.mewcode/instructions.md`
- 拼接：高优先级（项目根）在前，`\n\n---\n\n` 分隔
- `@include`：行级指令（`@include <path>` 单独成行）；展开该文件内容；visited 防环（重复文件跳过）；深度 >5 停止；路径 resolve 后 `startsWith(cwd)` 校验，越界跳过并 console.warn

### memory/session.ts
- JSONL：`appendFileSync(file, JSON.stringify(msg) + '\n', 'utf8')`（追加写，崩溃只丢最后一行）
- recoverLatest：目录扫描按文件名（时间前缀）排序取最新 → 读全部行 → `JSON.parse` try/catch 跳过坏行 → **截断**：从尾部回溯，遇 `role:'tool'` 无前驱 assistant(tool_calls) 或 assistant(tool_calls) 无后续 tool 结果 → 截断到该轮之前
- token 超限：恢复后用 P7 TokenEstimator 估算，超 `window - margin` → 调 ContextManager.beforeRequest 压一次
- 时间提醒：最后消息时间 vs now >24h → 前置插入 system 消息「距上次对话已超过 24 小时（N 天），上下文信息可能过时，重要内容请重新验证」
- cleanup：扫描文件 mtime >30 天 → 删除

### memory/notes.ts
- 笔记 Prompt：system「你是 MewCode 的记忆整理器。分析对话，输出 JSON：`{"notes":[{"category","title","content","action"}]}`。action=create 新增 / update 更新（已有同名标题时）。只记录值得长期记住的：用户偏好、纠正、项目知识、参考资料。禁止调用工具。」
- 输入消息：现有索引（项目+用户）+ 最近一轮（user 问题 + assistant 最终回复）
- 解析：JSON.parse（失败静默）；逐条写文件 `memory/<date>-<slug>.md`（frontmatter `---\ncategory: x\ndate: ...\ntitle: ...\n---`）
- 索引生成：扫两目录笔记文件 → 每笔记一行 `- [category] title — 摘要（首行）`；超 200 行/25KB 截断
- 异步：调用方 fire-and-forget，异常 catch 静默

### tui/useStream.ts（挂钩）
- 启动：接收 sessionStore/instructions/notesDirs；recoverLatest 填充 history（send 前完成）
- send 前：`systemPrompt = buildPrompt(mode, planCtx) + '\n\n## 项目指令\n' + instructions + '\n\n## 记忆索引\n' + buildNotesIndex()`（索引每次 send 前读，笔记可能异步更新）
- send 结束（finally 后）：记录 send 前 history 长度，结束后 diff 新消息 → sessionStore.append
- done reason=complete 且最后一轮无工具调用：`updateNotes(provider, 最近一轮, dirs).catch(() => {})`（异步不阻塞）

### cli.tsx（启动）
- 创建 SessionStore、loadInstructions、notes 目录初始化
- SessionStore.cleanup() + recoverLatest（日志提示恢复的会话）

## 文件组织

```
D:\MewCode\
├── src/
│   ├── memory/
│   │   ├── instructions.ts
│   │   ├── session.ts
│   │   ├── notes.ts
│   │   └── index.ts
│   ├── tui/useStream.ts    — session 挂钩 + 注入 + 异步笔记
│   └── cli.tsx             — 启动初始化
├── test/memory_test.ts     — 指令/存档/恢复/清理/笔记/索引
└── docs/phase8/            — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 注入位置 | 主 system 尾部（buildPrompt 后追加） | 用户决策（模型直接看到） |
| 存档时机 | send 结束后 diff 追加 | 简单可靠，内部操作不落盘 |
| 恢复 | 最新文件 + 截断/压缩/提醒 | 用户决策 |
| 笔记时机 | done 自然停后 fire-and-forget | 用户决策（异步不阻塞） |
| 索引重读 | 每次 send 前读文件 | 笔记异步更新可见 |
| 去重 | LLM 判断（现有索引作上下文） | 用户决策 |
| 时间提醒阈值 | >24h | 常见会话间隔 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 指令文件 | memory/instructions.ts |
| F2 会话存档 | memory/session.ts |
| F3 会话恢复 | session.recoverLatest + useStream 填充 |
| F4 过期清理 | session.cleanup（cli 启动） |
| F5 自动笔记 | memory/notes.ts + useStream 异步触发 |
| F6 记忆索引 | notes.buildNotesIndex + useStream 注入 |
| N1 崩溃安全 | JSONL 追加写 + 坏行跳过 |
| N2 异步不阻塞 | fire-and-forget + catch 静默 |
| N3 索引上限 | 截断逻辑 |
