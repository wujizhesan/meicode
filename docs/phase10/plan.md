# MewCode Phase10 Plan — Skill 系统

## 架构概览

新增 `skill/` 层：加载（三级+覆盖）→ 管理（激活/索引/白名单）→ 执行（shared 注入 / isolated 独立会话）。两阶段：启动注入索引（name+description），`load_skill` 工具激活时注入完整指令并注册斜杠命令。

```
cli 启动
  → SkillManager.loadAll()（内置/用户/项目三级，同名覆盖，坏文件跳过）
  → 索引段注入 system（仅 name+description）
  → useStream send 前:
      activePrompt() 段 → 独立 system 消息（轮次指令后，不进稳定前缀）
      toolsOverride（激活白名单并集 + 系统工具）
  → load_skill 工具（模型调用或斜杠命令）:
      activate(name, args) → 完整指令注入 + 专属工具注册 + 斜杠命令注册
      mode=isolated → 独立 runAgent + LLM 摘要回流
  → /clear → skillManager.clear()
```

依赖：skill → provider/history/commands 类型；tui → skill。无环。

## 核心数据结构

### SkillDef / ActiveSkill
```ts
interface SkillDef {
  name: string
  description: string
  tools?: string[]          // 工具白名单
  mode: 'shared' | 'isolated'
  history?: number          // isolated 带主历史条数（默认 5）
  model?: string
  content: string           // SOP 正文（{{param}} 占位）
  source: 'builtin' | 'user' | 'project'
}

interface ActiveSkill {
  def: SkillDef
  params: Record<string, string>   // {{param}} 替换值
}
```

### SkillManager
```ts
class SkillManager {
  constructor(dirs: { builtin: string; user: string; project: string })
  loadAll(): { ok: string[]; skipped: string[] }
  // 三级扫描（目录型：SKILL.md + tools/ + scripts/）；同名项目>用户>内置覆盖
  // 白名单校验：tools 中存在未知工具 → 警告 + 该 Skill 标记不可用
  index(): string                    // 启动注入：'## 可用 Skills\n- name: description'
  activate(name, params?): string    // 激活：注入完整指令；斜杠注册回调；isolated 返回提示
  deactivate(name): void
  clear(): void                      // /clear 用
  activePrompt(): string             // 激活 Skill 完整指令拼接（{{param}} 已替换）
  activeToolNames(): string[] | null // 激活白名单并集（无激活 → null）
  get(name): SkillDef | undefined
}
```

## 模块设计

### skill/types.ts
SkillDef / ActiveSkill / SkillDirs。

### skill/loader.ts
- 扫描三个目录：`*.md`（文件型）+ `<name>/SKILL.md`（目录型）
- frontmatter：`---\n...\n---` 提取 → yaml parse → 校验（name/description 必需，mode 缺省 shared）
- 目录型：`tools/*.json`（schema）与 `scripts/*.js`（实现）→ 包装为 Tool（execute 调脚本？——第一版：目录型专属工具用 `require` 加载脚本模块导出 execute？——简化：目录型工具的 scripts 是 .js 模块导出 `{ execute(args, ctx) }`，动态 import）
- 坏文件（parse 失败/缺 name）→ skipped 列表 + console.warn

### skill/manager.ts
- loadAll：三级加载 + 覆盖（后加载的高优先级盖低）
- activate：set active；调 onActivate 回调（注册斜杠命令）
- activePrompt：`## 已激活 Skill: <name>\n\n<content 替换 {{param}}>` 多 Skill 按激活顺序拼接
- 白名单：activeToolNames = 各激活 Skill tools 并集（去重）

### skill/load_skill 工具
```ts
// skill/index.ts 导出
function createLoadSkillTool(manager: SkillManager, ctx: { onCommand: (name, handler) => void }): Tool
// name='load_skill'，系统级
// execute: manager.activate(name, args) → 返回激活结果文本
// 白名单校验在 loadAll 已做；激活时若不可用返回错误
```

### agent/loop.ts（toolsOverride 支持）
```ts
opts.toolsOverride?: { name; description; parameters }[] | null
// runAgent 内: const tools = opts.toolsOverride ?? (mode === 'plan' ? 只读 : 全部)
// 激活 Skill 时 useStream 传 override（白名单并集 + 系统工具 + load_skill）
```

### tui/useStream.ts（挂钩）
- 接收 SkillManager
- send 前：activePrompt() 作为独立 system 消息（插在轮次指令之后）；toolsOverride 计算
- isolated 模式：load_skill 返回 mode=isolated → 触发 runIsolated：
  ```ts
  async function runIsolated(skill, mainHistory, provider, registry, ctx): Promise<string> {
    const sub = new History()
    for (const m of mainHistory.all().slice(-(skill.history ?? 5))) sub.push(m)
    const agent = runAgent({ ..., history: sub, maxIterations: 8 })
    // 收集输出 → LLM 摘要 → 返回摘要文本
  }
  ```
  摘要回流：主对话 push 一条 `[Skill <name> 结果] <摘要>` 消息（role: system）
- /clear：clearHistory 里调 skillManager.clear()

### commands（动态注册）
- CommandRegistry 已有动态 register；Skill 激活时注册 `/<skill名>`：
  handler = (args, ui) => ui.sendUserMessage(`使用 Skill ${name}：` + (args.join(' ') || skill.description))
  —— shared 模式：直接激活 + 发消息触发执行
  —— isolated 模式：触发独立会话

### 内置样板（src/skills/）
- commit.md：tools [run_command, read_file, edit_file]，shared
- review.md：tools [run_command, read_file]，shared（取代现有 /review 命令——命令系统里 /review 移除或改为指向 review skill）
- test.md：tools [run_command, read_file]，isolated（独立跑测试摘要回流）

## 文件组织

```
D:\MewCode\
├── src/
│   ├── skill/
│   │   ├── types.ts
│   │   ├── loader.ts
│   │   ├── manager.ts
│   │   └── index.ts          — createLoadSkillTool + runIsolated
│   ├── skills/
│   │   ├── commit.md
│   │   ├── review.md
│   │   └── test.md
│   ├── agent/loop.ts         — toolsOverride
│   ├── tui/useStream.ts      — 激活注入 + isolated + /clear
│   └── commands/builtin.ts   — /review 移除（review skill 取代）
├── test/skill_test.ts
└── docs/phase10/             — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 激活注入 | 独立 system 消息（轮次指令后） | 显眼（F4）+ 不进缓存前缀（N3） |
| 白名单 | toolsOverride 传 runAgent | agent 层不感知 Skill |
| 白名单错误 | 警告 + 该 Skill 跳过 | F2 不阻断其他 |
| isolated | 独立 runAgent（maxIterations 8）+ LLM 摘要回流 | 防烧 token + 主历史精简 |
| 动态命令 | manager onActivate 回调 → CommandRegistry.register | 复用 P9 |
| /review 替换 | 命令系统移除，review skill 取代 | 用户决策 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 文件格式 | skill/types + loader frontmatter |
| F2 三级存放 | loader 扫描与覆盖 |
| F3 两阶段 | manager.index + load_skill |
| F4 激活状态 | manager.activePrompt + useStream 注入 |
| F5 两种模式 | shared 注入 / isolated runIsolated |
| F6 白名单 | manager.activeToolNames + loop toolsOverride |
| F7 斜杠/热更新/清理 | manager onActivate + /clear + 三样板 |
| N1 坏文件跳过 | loader skipped |
| N2 白名单 fail-fast | loadAll 校验警告 |
| N3 缓存稳定 | 独立 system 消息 |
