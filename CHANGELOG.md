# Changelog

## 0.1.4

- `--run` 默认使用新会话，支持显式 `--resume`，并补齐上下文压缩、spill、预算与会话持久化
- 新增无人值守安全权限模式，统一只读命令策略，结构化命令参数不再经过 shell 拼接
- 模型目录贯通上下文窗口与输出上限，支持通过环境变量加载 API key
- Doctor 增加本地运行环境与模型预算检查；发行包默认移除 source map
- 同步 CLI、A2A、MCP 版本与发行元数据
- 修复 ACP 取消链路、Anthropic 上下文预算锚点与 TUI 压缩会话持久化
- 显式 `--config` 文件支持 MCP/A2A 配置，MCP 首次发现失败可在下轮重试
- A2A Push 对流式文本更新进行合并和队列限流，终态通知保持可靠投递
- ACP/A2A 统一使用安全运行时上下文，默认启用 unattended、路径围栏、预算、压缩和 spill
- CI 扩展到 Windows/Linux 与 Node 20/22；全量测试改为受控并行执行
- TUI 命令注册改为按技能集合缓存，长会话流式刷新进一步限频
- 新状态目录统一为 `.meicode`，已有 `.mewcode` 目录继续兼容使用
- 移除未使用的直接依赖 `@alcalzone/ansi-tokenize` 与 `@types/express`
- 拆分记忆上下文、无人值守执行器与 TUI 展示辅助逻辑，降低 CLI/TUI 模块耦合
- 拆分团队/Workflow 命令处理和 Agent Loop 止损逻辑，阻断 Workflow 名称路径穿越并回显异步团队操作失败
- 拆分 TUI 会话生命周期与 Agent 工具权限执行链，保持读工具并发、写工具串行和审批缓存语义
- 拆分 TUI 流式事件状态机与 ACP/A2A 服务宿主，补齐监听失败回滚、幂等关闭和 CLI 退出 Hook
- 统一 TUI 发送异常清理并按 MCP Server 增量重试发现，避免前置异常卡死、重复工具注册和 Ctrl+C 绕过退出清理
- 打通权限询问与 Elicitation 的 AbortSignal 取消链路，并为 Hook、MCP、Team 和 HTTP 服务关闭增加超时保护
- 拆分 TUI 发送收尾与 CLI 会话 Runtime Bootstrap，隔离 Skill、Hook、持久化失败并统一会话恢复初始化
- 修复子 Agent `isolation: worktree` 配置失效、重复收尾与超时哨兵冲突，并为 A2A messageId 去重建立索引和重启终态幂等保护
- 修复 TUI 多候选命令补全无法回填选中项，并将 TeamManager 任务超时判定改为类型安全结果
- Workflow 增加跨进程执行租约、revision/CAS、取消与自动续跑，并在并行任务失败时取消和排空兄弟执行者；会话、成员及团队/子 Agent 持久化同步加固

## 0.1.3

- 公共发行包移除逆向专用 Agent、工具和 Prompt；逆向模块保留在本机私有目录

## 0.1.2

- 修复完整 OpenAI/Anthropic endpoint 被重复追加路径导致 DeepSeek 返回 404

## 0.1.1

- 修复 Windows CRLF 文件导致内置 Skill 与子 Agent frontmatter 被跳过的问题

## 0.1.0

- 初始发行版
- 多智能体团队编排、Workflow、Skill、MCP 和权限控制
- A2A / ACP 服务、任务持久化、审计与限流
- Node 20 ESM 编译发行包
