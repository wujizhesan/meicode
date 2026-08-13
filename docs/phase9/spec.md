# MewCode Phase9 Spec — 命令系统

## 背景

P1-P8 已有零散斜杠处理（/mode /plan /compact /resume 直接写在 App.handleSend 里，硬编码分支）。本阶段设计统一命令注册分发机制：斜杠输入绕过 Agent 直接执行本地操作或触发预设提示词——响应快、省 Token、行为确定，不用 LLM 处理清屏/查状态这类杂事。

## 目标

- 命令注册中心统一管理元数据，启动检测别名冲突
- 三类命令（纯本地 / 影响界面 / 预设提示词）统一分发
- 界面控制接口解耦渲染框架
- 别名 + Tab 补全
- 十个内置高频命令

## 功能需求

- F1: 命令注册中心 —— CommandRegistry：登记命令元数据（name / aliases / description / usage / type / paramHint / hidden / handler）；启动阶段检测别名冲突与保留名冲突，撞名**立即 panic 退出**（不等运行时）
- F2: 解析器 —— 识别斜杠前缀；第一个空格前为命令名、之后为参数；命令名转小写（大小写不敏感）；空输入/纯斜杠早返回；未命中命令提示「未知命令，输入 /help 查看」
- F3: 三类命令 —— `local`（纯本地：清屏、状态、会话操作）、`ui`（影响界面状态：模式切换）、`prompt`（预设提示词送进对话交给 AI：/review 等）
- F4: 界面控制接口 —— `UiController` 抽象层：`showMessage`（界面显示消息）、`sendUserMessage`（把文本作为用户消息送进对话）、`setMode`（切换模式）、`getStatus`（模式/token/缓存/会话）；命令实现只依赖该接口，不绑定 Ink；状态栏模式标记与命令联动（[DEFAULT]/[PLAN]/[EDITS]/[YOLO]）
- F5: 分流器 —— 用户回车入口统一走 dispatcher：`/` 开头 → 命令分发（本地执行，不进对话）；否则 → 正常发送给 Agent
- F6: Tab 补全 —— 输入中按 Tab：单匹配直接补全、多匹配弹出候选菜单（方向键选择）、隐藏命令不参与补全
- F7: 十个内置命令 —— /help（命令列表与用法）、/compact（手动压缩上下文）、/clear（清空当前对话历史，会话存档保留）、/plan（进入计划模式，可带任务）、/do（退出计划模式回 default）、/session（会话管理：无参列表、`<id>` 恢复、`new` 新建；/resume 为别名）、/memory（查看记忆笔记列表与索引）、/permission（查看当前权限模式与规则概要）、/status（显示模式/token/缓存命中/会话状态）、/review（预设提示词：审查最近 git 变更——让 AI 跑 git diff 并分析问题与建议）

## 非功能需求

- N1: 命令执行不经过 LLM（省 token、响应快）——prompt 类命令只在触发时送一条预设消息
- N2: 冲突启动即爆（fail-fast），不在运行时出错
- N3: 补全不打断输入（Tab 后继续可编辑）

## 不做的事

- 用户自定义命令（留给 Skill 系统）
- 动态生成提示词模板
- 命令级权限控制

## 验收标准

- AC1: 注册中心 —— 登记十命令元数据齐全；构造时注入别名冲突（两个命令同别名）→ 启动即抛错
- AC2: 解析器 —— `/HELP`（大写）命中 /help；`/` 单独输入早返回；未知命令提示 /help 引导；参数解析（`/session 2026xxxx` → name=session, args=[2026xxxx]）
- AC3: 三类分发 —— local 命令不产生任何对话请求；prompt 命令触发 sendUserMessage 一次
- AC4: UiController —— 命令实现 mock 接口可独立测试（不依赖 Ink）
- AC5: 分流器 —— `/status` 走命令分支；`你好` 走对话分支
- AC6: Tab 补全 —— 单匹配补全；多匹配（输入 /m → /memory /mode）弹菜单；隐藏命令不出现在候选
- AC7: 十命令行为 —— /help 输出列表；/clear 后历史清空但 JSONL 存档仍在；/plan 切模式；/do 回 default；/session 列表/恢复；/memory 显示笔记；/permission 显示模式；/status 显示状态；/review 触发一次带 git 审查提示词的对话
- AC8: 回归 —— 全部现有测试绿

## 命令表

| 命令 | 类型 | 行为 |
|------|------|------|
| /help | local | 命令列表与用法 |
| /compact | local | 手动压缩（调 ContextManager） |
| /clear | local | 清空对话历史（存档保留） |
| /plan [任务] | ui | 进入计划模式（带任务则直接发送） |
| /do | ui | 退回 default 模式 |
| /session [id\|new] | local | 列表/恢复/新建（/resume 别名） |
| /memory | local | 笔记列表与索引 |
| /permission | local | 权限模式与规则概要 |
| /status | local | 模式/token/缓存/会话 |
| /review | prompt | 预设「审查 git 变更」提示词送对话 |
