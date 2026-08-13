# MeiCode

MeiCode 是一个运行在终端里的命令行 AI 助手：可以直接操作文件系统、执行命令、搜索代码，通过 Skill 系统扩展能力，并内置**多智能体团队编排**——主会话可以派生专职专家成员（协程驻留、worktree 隔离），并行拆解复杂任务。

TypeScript / ESM / Node.js，无框架依赖（终端 UI 用 Ink）。

## 核心特性

### 1. Agent 主循环（`src/agent/loop.ts`）
- 完整工具调用循环：模型请求 → 工具执行 → 结果回流，支持流式输出与中断取消
- **上下文安全**：请求前 sanitize（防不完整 assistant(tool_calls) 引发 400）、超限自动压缩重试、spill 溢出落盘
- **防死循环**：重复工具调用检测（写类/命令分级阈值）
- **轮次管理**：剩余轮数提醒（报告优先）、团队任务进行中纯文本轮不判完成

### 2. 多智能体团队编排（`src/team/`）
- **协程驻留成员**：派生后长期驻留，独立上下文（history 落盘可恢复），邮箱协作（IDLE/PLAN/APPROVE 协议）
- **worktree 隔离**：每个成员独立 git worktree，写文件不污染主仓库；报告写契约目录、中间产物写共享区
- **专家角色**：team-lead（编排经理）/ research / data / protocol / implement / qa 等 16 个角色，按 frontmatter 配置 max_rounds / write_paths / tools_allow
- **编排保障**：等待纪律（3 轮一查，防空转烧 token）、死亡感知（异常终止归 failed + ERR 邮件通知 Lead）、降级收尾（Lead 失联时自行汇总写报告）

### 3. Workflow 系统（`src/workflow/`）
- `.workflow.js` 声明式 DSL（`export const meta = { name, description, phases }`），项目级/用户级目录
- `/workflow create|validate|run` + `/workflows` 运行记录——phase 状态机、产物 `artifacts/<phase>.md`、JSON 持久化
- phase 可选 fork 子 agent 或 coroutine 团队成员两种后端

### 4. 权限与安全（`src/permission/`、`src/tools/`）
- 四级权限模式（default / edits / plan / yolo）+ 确认会话记忆
- **路径围栏**：成员写文件限 worktree 内，报告契约目录白名单；命令围栏防绕过（只读命令豁免、绝对路径/穿越拦截）
- 危险命令黑名单（16 类）
- 快照/回滚（git tag 安全网）

### 5. 工具链
- 读写/编辑文件、执行命令（Windows/cmd 兼容提示）、代码搜索（grep/find）
- 代码分析工具：字符串提取 / 反混淆 / 字节偏移提取 / 截图 diff
- 浏览器自动化、MCP 客户端集成
- 子 Agent（spawn_agent + 16 个预置角色）、Hook 引擎（round_start/subagent_start 等）

## 快速开始

```bash
npm install
npm start          # 交互模式
npm start -- --run "任务描述"   # 无人值守模式
npm test           # 18 个测试文件，全部通过
```

## 配置

复制 `config.example.yaml` 为 `~/.mewcode/config.yaml`，填入模型 provider 与 API key（支持 deepseek / kimi / qwen / bigmodel / mimo 模型目录，一行切换）。

## 常用命令

```
/mode default|edits|plan|yolo   权限模式切换
/team create|spawn|assign|tasks|merge   团队编排
/workflow create|validate|run   工作流
/session /compact /resume       会话管理
```

## 目录结构

```
src/
├── agent/       # 主循环、事件、prompt 构建
├── team/        # 团队编排（成员/邮箱/任务/锁）
├── workflow/    # Workflow DSL + 运行器 + 持久化
├── subagent/    # 子 Agent 与角色系统
├── tools/       # 工具实现（含路径围栏）
├── permission/  # 权限规则与黑名单
├── mcp/         # MCP 客户端
├── hook/        # Hook 引擎
├── worktree/    # git worktree 隔离管理
├── tui/         # Ink 终端界面
└── commands/    # 斜杠命令系统
```

## 许可

MIT
