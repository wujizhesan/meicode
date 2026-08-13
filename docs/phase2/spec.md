# MewCode Phase2 Spec — 工具系统

## 背景

Phase1 已交付纯对话 CLI（Anthropic/OpenAI 双后端、SSE 流式、YAML 配置、Ink TUI，`D:\MewCode`）。本阶段给 MewCode 装上工具系统：模型不再只能动嘴，而是能读文件、写文件、改文件、执行命令、搜索代码——从聊天机器人变成能干活的 Agent。

当前实际使用后端：DeepSeek V4 Flash（OpenAI 兼容协议，`https://api.deepseek.com`，model `deepseek-v4-flash`）。

## 目标

- 模型识别自己要用哪个工具，MewCode 执行，把结构化结果喂回模型，模型据此生成最终回复
- 六个核心工具 + 统一 Tool 接口 + 注册中心
- 本阶段只做**单轮**工具调用（模型调一次 → 执行 → 结果回灌 → 最终回复），Agent Loop（连环调用）留到下一章

## 功能需求

- F1: Tool 接口 —— 统一接口：`name`（唯一标识）、`description`（给模型看的用途说明）、`parameters`（JSON Schema 参数定义）、`execute(args)`（执行方法）；每个工具实现该接口
- F2: 六个核心工具 —— read_file（读文件）、write_file（写文件）、edit_file（改文件）、run_command（执行命令）、find_files（按 glob 模式找文件）、grep_code（按正则搜代码内容）
- F3: 注册中心 —— 集中登记全部工具；按名查找（查不到报清晰错误）；转成 OpenAI 协议认得的 `tools` 列表格式（type/function/name/description/parameters）
- F4: 执行保障 —— 工具执行带超时（命令类默认 30s）；任何异常（参数缺失、文件不存在、命令失败）都转成**结构化结果**返回给模型（含 success/error 标志与可读信息），不崩溃
- F5: OpenAI 流式工具调用解析 —— 解析 SSE 流中的 `tool_calls` delta 分片（按 index 聚合碎片化的 `name`/`arguments` JSON），拼出完整参数对象；解析失败给出明确错误
- F6: 单轮工具循环 —— 模型输出工具调用 → 执行工具 → 工具结果作为 assistant tool 消息回灌对话历史 → 模型再生成一次（最终回复）→ 展示给用户；若第二轮模型再次调用工具，截断并提示「本阶段暂不支持连环调用」
- F7: 改文件规则 —— 原文唯一匹配替换：提供旧文本片段，文件中恰好匹配一处才替换；零匹配或匹配多处均返回带位置的明确错误，让模型重试
- F8: 命令确认 —— run_command 执行前在 TUI 弹确认（显示命令内容，Enter 执行 / Esc 或 Ctrl+C 拒绝）；拒绝则返回「用户拒绝执行」的结构化结果
- F9: 工作目录 —— 工具相对路径基于 MewCode 启动时的 cwd；支持绝对路径

## 非功能需求

- N1: 结果大小限制 —— 工具返回内容超过阈值（默认 8KB）截断并标注，防止上下文爆炸
- N2: 失败不崩 —— 任何工具执行路径的异常都被捕获并转为结构化错误结果
- N3: 执行安全 —— 命令执行不经过 shell 字符串拼接以外的注入面（参数数组方式执行）；确认机制不可绕过
- N4: 兼容 Phase1 —— 纯对话模式仍然可用（不强制模型用工具）

## 不做的事

- 多工具连环调用 / Agent Loop（下一章）
- Anthropic 协议的工具调用（`input_json_delta`）
- 精细权限系统（目录白名单、命令黑名单）——只做 run_command 确认
- 工具并行执行
- 用户自定义工具/插件机制
- 命令历史与撤销

## 验收标准

- AC1: 注册中心登记六个工具，转 OpenAI `tools` 格式后 name/description/parameters 齐全
- AC2: 六个工具各自可直接调用：合法参数返回预期结果，非法参数返回结构化错误
- AC3: 与 DeepSeek 真实联调：提问「读一下 D:\MewCode\package.json」→ 模型调 read_file → 结果回灌 → 最终回复展示正确内容
- AC4: 流式解析：构造含 tool_calls 分片（index 分片 + arguments 碎片）的 SSE → 聚合出完整参数
- AC5: edit_file：唯一匹配替换成功；零匹配/多匹配返回带位置的明确错误
- AC6: run_command：弹确认；Enter 执行、拒绝不执行；超时（构造睡眠命令）触发超时错误
- AC7: 工具失败场景（如读不存在的文件）→ 结构化错误回灌 → 模型再生成不崩溃，回复能体现错误信息
