# MewCode Phase12 Spec — 子 Agent 系统

## 背景

P1-P11 已交付完整单 Agent。复杂任务需要委派——本阶段主 Agent 可把子任务交给独立子 Agent：干净上下文、受限工具集、独立权限追踪，结果异步回流，上下文污染彻底解决。

## 目标

- 统一 `spawn_agent` 工具（defined / fork 两路径）
- 定义式角色（Markdown + frontmatter，多来源覆盖）
- 运行时状态隔离、基础设施共享
- 「跑到底」非交互执行 + 后台任务管理
- 多层工具过滤防无限嵌套

## 功能需求

- F1: spawn_agent 工具 —— 统一工具（工具列表稳定）：参数 `type`（defined / fork）+ `role`（定义式角色名）+ `prompt`（任务描述）；defined 从空白对话 + 固定角色启动；fork 继承父对话历史与工具集（首次请求命中 prompt cache 降成本）
- F2: 角色定义 —— Markdown + YAML frontmatter：`name` / `description` / `tools_allow`（白名单）/ `tools_deny`（黑名单）/ `model`（继承或指定）/ `max_rounds` / `permission`（权限模式）；正文是子 Agent 系统提示；加载优先级：项目 `agents/` > 用户 `~/.mewcode/agents/` > 内置 `src/agents/`（前者覆盖后者）
- F3: 运行时状态隔离 —— 子 Agent 独立 History（消息）、独立权限上下文（模式可不同）、独立 token 计数；共享 LLM 客户端、Hook 引擎、文件系统（基础设施不重复）
- F4: 「跑到底」模式 —— 非交互执行：模型不再调工具即完成（complete）；结果经 LLM 摘要后异步回流主对话（`📦 [子任务 <role>] 结果摘要` 消息）
- F5: 多层工具过滤 —— ① 全局禁止集（spawn_agent 对子 Agent 默认禁用——防无限嵌套，角色 `tools_allow` 显式含 spawn_agent 才允许）② 角色黑名单额外限制 ③ 后台白名单（Fork 式限制）；过滤后工具集传给子 Agent
- F6: 后台任务管理器 —— 追踪状态（running/done/error）、结果、token 用量；三种进入后台：显式指定（`async: true`）、超时自动（同步等待超过阈值自动转后台）、手动切换；**Fork 式强制后台**；完成异步通知回主对话
- F7: P11 对接 —— Hook 的 `subagent` 动作占位改为调用真实 spawn（role 参数），async 执行

## 非功能需求

- N1: 子 Agent 失败不污染父上下文（结果摘要化；原始输出只在任务记录）
- N2: 嵌套防护默认开启（子 Agent 工具集默认无 spawn_agent）
- N3: 后台任务不阻塞主对话（fire-and-forget + 异步通知）

## 不做的事

- Worktree 文件隔离
- 多 Agent 团队编排（任务路由/协商）
- 后台任务跨会话持久化

## 验收标准

- AC1: 角色加载 —— frontmatter 解析、四来源覆盖（项目>用户>内置）、坏文件跳过
- AC2: spawn_agent defined —— 空白历史 + 角色 system 提示启动；工具集 = 角色白名单过滤后（含全局禁止与黑名单）
- AC3: spawn_agent fork —— 继承父历史尾部 + 工具集；请求命中缓存（usage cacheHit 断言）
- AC4: 嵌套防护 —— 子 Agent 工具集默认不含 spawn_agent；角色显式 allow 时可用
- AC5: 后台管理 —— 显式 async / 超时自动转后台 / 状态追踪（running→done） / 结果回流消息
- AC6: 结果回流 —— 子任务完成后主对话出现 `📦 [子任务 <role>]` 摘要消息
- AC7: P11 subagent 动作 —— Hook subagent 动作触发真实 spawn
- AC8: 回归 —— 全部现有测试绿

## Agent 角色格式

```markdown
---
name: code-reviewer
description: 审查代码变更并输出问题列表
tools_allow: [run_command, read_file, grep_code]
tools_deny: [write_file]
model: inherit
max_rounds: 10
permission: default
---

# Code Reviewer

你是资深代码审查员。审查时：
1. 先读取变更内容
2. 按严重程度输出问题列表
3. 只审查，不修改任何文件
```

## 后台任务管理

```
spawn_agent 调用 → SubAgentManager.spawn()
  ├─ 显式 async: true → 立即后台
  ├─ 同步等待（默认）→ 超时阈值（30s）→ 自动转后台 + 提示
  ├─ fork 强制后台
  └─ 完成 → LLM 摘要 → 主对话回流「📦 [子任务 <role>] 结果」
```
