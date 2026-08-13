# MewCode Phase13 Spec — Worktree 隔离

## 背景

P12 已支持多子 Agent 并行，但子 Agent 与主 Agent 共享同一工作目录——并行改文件会互相覆盖。本阶段用 Git worktree 给每个声明隔离的子 Agent 开独立工作目录：共享版本库、各自分支、文件操作互不干扰。

## 目标

- Git worktree 隔离（目录放仓库内不被追踪位置）
- 目录名安全校验（防路径遍历）
- 完整生命周期（创建/进入/退出/删除）+ 环境初始化
- explicit cwd（不 chdir）+ 绝对路径缓存 key
- 角色 `isolation: worktree` 显式声明
- 变更保护 + 过期清理

## 功能需求

- F1: Worktree 创建 —— Git worktree（同一仓库多目录、共享版本库、各自分支），目录放 `<cwd>/.mewcode/worktrees/<name>/`（仓库内不被追踪）；分支名 `wt-<name>`
- F2: 目录名安全校验 —— 限字符集（`[a-zA-Z0-9_-]` 及斜杠）、长度 ≤64、拒绝 `.`/`..` 段（含嵌套）、拒绝绝对路径与盘符前缀——防 LLM 输入路径遍历
- F3: 生命周期 —— `create`（含快速恢复：目录已存在时只读文件系统校验，不调 git）、`enter`（返回 worktree 路径）、`exit`（变更检查）、`remove`（保护性删除）
- F4: 环境初始化 —— 创建后：复制本地配置（如 `.env`、`config.*` 等）、配置 worktree 内 git hooks（软链或复制）、软链大依赖目录（node_modules）、按规则补被 gitignore 但运行需要的文件
- F5: explicit cwd —— 不 chdir：worktree 路径作为 ctx.cwd 显式传给子 Agent 的每个工具调用（工具已用 ctx.cwd ✓）；路径相关缓存（P7 上下文估算锚点、记忆注入、指令加载、MCP 缓存）确认用绝对路径 key——按目录天然隔离，切换不清缓存
- F6: 子 Agent 隔离模式 —— 角色 frontmatter 加 `isolation: worktree` 字段；spawn 时自动创建 worktree → 子 Agent ctx.cwd = worktree 路径 → 注入路径说明（system prompt 告知「工作目录在 <path>」）→ 完成后按变更情况：有变更保留待合并（返回路径+分支名）、无变更自动清理
- F7: 变更保护与清理 —— 删除前检查：有未提交修改或未推送 commit → 默认拒绝删除并提示；启动时 + 子 Agent 会话退出时扫描清理过期（>7 天且无未提交变更）的 worktree；三层过滤保证安全（路径在校验规则内、在 worktrees 根下、git worktree list 中）

## 非功能需求

- N1: worktree 内工具调用与主目录完全隔离（沙箱路径校验用 worktree 绝对路径）
- N2: 删除保护优先（有变更绝不静默删除）
- N3: 快速恢复路径不执行 git 写操作（目录已存在即复用）

## 不做的事

- Worktree 间合并策略（上层 git merge 决定）
- 跨目录代码同步
- 多 Agent 并行编排

## 验收标准

- AC1: 创建 —— git worktree 建在 `.mewcode/worktrees/<name>/`，分支 `wt-<name>`；目录名安全校验（`.`/`..`/盘符/超长/非法字符拒绝）
- AC2: 快速恢复 —— 目录已存在时复用（不重复 git worktree add）；只读校验
- AC3: 环境初始化 —— node_modules 软链、配置文件复制、hooks 配置、被忽略文件补全
- AC4: explicit cwd —— 子 Agent 工具调用收到 worktree 路径（ctx.cwd 断言）；主目录文件不被修改
- AC5: 隔离声明 —— 角色 `isolation: worktree` → spawn 自动建 worktree + 注入路径说明；无声明角色不隔离
- AC6: 变更保护 —— 有未提交修改时 remove 拒绝并提示；无变更可清理
- AC7: 过期清理 —— 启动/退出时清理 >7 天无变更的 worktree；三层过滤
- AC8: 回归 —— 全部现有测试绿

## Worktree 角色示例

```markdown
---
name: refactorer
description: 重构代码（在隔离 worktree 中执行）
isolation: worktree
max_rounds: 15
---

# Refactorer

你在独立工作目录中重构代码...
```
