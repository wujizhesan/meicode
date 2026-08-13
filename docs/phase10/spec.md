# MewCode Phase10 Spec — Skill 系统

## 背景

P1-P9 已交付完整 Agent + 命令系统。用户反复输入同样的提示词（commit/review/test 等）——本阶段把可复用 AI 操作封装为 Skill：Markdown 文件 + 元信息，两阶段加载（启动只见名字说明、用时按需加载完整指令），两种执行模式（共享/独立），工具白名单提升选对工具准确率。

## 目标

- Skill 文件标准化（frontmatter + SOP 正文）
- 三级存放（项目 > 用户 > 内置），同名覆盖
- 两阶段加载 + 激活钉在上下文最显眼位置
- 共享/独立两种执行模式
- 工具白名单 + 斜杠短命令 + 热更新
- 内置 commit / review / test 三个样板

## 功能需求

- F1: Skill 文件格式 —— YAML frontmatter：`name`（唯一）、`description`（一句话）、`tools`（可见工具白名单）、`mode`（shared / isolated）、`history`（独立模式带多少历史，可选）、`model`（指定模型，可选）；正文是发给模型的 SOP 指令；正文支持 `{{param}}` 占位符（加载时用用户传入参数替换）
- F2: 三级存放 —— 项目 `<cwd>/skills/` > 用户 `~/.mewcode/skills/` > 内置 `src/skills/`；同名按优先级覆盖（项目最高）；解析失败（frontmatter 坏/缺 name）单个跳过并提示，不阻断整体加载
- F3: 两阶段加载 —— 启动时只把 Skill 的 name + description 注入对话（skill 索引段）；用户请求或斜杠命令触发时，内置 `load_skill` 工具按需加载：完整指令 + 专属工具（目录型 Skill 的 schema 与脚本注册进 registry）
- F4: 激活状态 —— 激活后的完整指令钉在 system prompt 最显眼位置（指令段顶部，每轮重建都在）；多个 Skill 可同时激活（按激活顺序排列）
- F5: 两种执行模式 —— `shared`：Skill 指令注入主对话，执行结果留在主历史；`isolated`：开独立 runAgent 会话跑（history 条数由 frontmatter 的 `history` 字段定），跑完后 LLM 生成结果摘要回流主对话展示
- F6: 工具白名单 —— Skill 激活后该轮请求的 tools 列表收窄为：Skill 白名单工具 + 系统工具（内置六个 + `load_skill`）；白名单里出现不存在的工具名 → 启动/加载时立刻报错；`load_skill` 是系统级工具，不受任何白名单约束
- F7: 斜杠短命令与热更新 —— Skill 加载后自动注册 `/skill名` 短命令（激活即用）；重新加载时重读文件（热更新）；`/clear` 清空对话时顺带清除已激活 Skill；内置 commit（提交 git 变更）、review（git 变更审查，取代现有 /review 命令）、test（跑测试并分析失败）三个样板

## 非功能需求

- N1: 单个 Skill 文件坏不影响其他（跳过 + 提示）
- N2: 白名单错误启动即报（fail-fast）
- N3: Skill 指令注入不破坏主 system 前缀的缓存稳定性（激活 Skill 段放在轮次指令之后，变化内容不进稳定前缀）

## 不做的事

- Skill 市场分发与版本管理
- Skill 依赖管理

## 验收标准

- AC1: Skill 解析 —— frontmatter 字段齐全；正文 SOP 与 `{{param}}` 占位符替换正确
- AC2: 三级覆盖 —— 项目同名 Skill 覆盖内置；坏 frontmatter 文件跳过不影响其他
- AC3: 两阶段 —— 启动注入仅 name+description；`load_skill` 后完整指令与专属工具可用
- AC4: 激活注入 —— 激活 Skill 指令每轮重建且位于显眼位置；多 Skill 同时激活
- AC5: 执行模式 —— shared 结果留主历史；isolated 独立会话跑完 LLM 摘要回流（fake 断言）
- AC6: 白名单 —— 激活后请求 tools 仅含白名单+系统工具；白名单不存在工具报错；`load_skill` 始终可用
- AC7: 斜杠与清理 —— 激活注册 `/skill名`；`/clear` 后激活 Skill 清除；三样板（commit/review/test）可加载
- AC8: 回归 —— 全部现有测试绿

## Skill 定义格式

```markdown
---
name: commit
description: 提交 git 变更（生成或使用提交信息）
tools: [run_command, read_file]
mode: shared
---

# Commit Skill

1. 运行 git status 查看变更
2. 运行 git diff --stat 了解改动范围
3. 提交信息：用户提供则用「{{message}}」，否则根据改动生成
4. 运行 git add -A && git commit -m "<信息>"
5. 报告提交结果
```

目录型 Skill（能力包）：
```
skills/my-skill/
├── SKILL.md        — 入口（frontmatter + SOP）
├── tools/          — 专属工具 schema
│   └── <name>.json
└── scripts/        — 实现脚本
    └── <name>.js
```
