# MeiCode

## 安装发行版

两种方式装完都是同一个 `meicode` 命令。

从 npm 安装（公开包，无需登录）：

```powershell
npm install -g @wujizhesan/meicode
meicode --version
```

或者从 GitHub Release 下载编译好的 tgz（仓库是私有的，需要 `gh auth login` 过）：

```powershell
$tag = gh release view -R wujizhesan/meicode-private --json tagName --jq .tagName
gh release download $tag -R wujizhesan/meicode-private -p "*.tgz"
npm install -g "./wujizhesan-meicode-$($tag.TrimStart('v')).tgz"
meicode --help
meicode --version
meicode --init
meicode --doctor
```

GitHub Release 提供编译后的发行包，不需要 npm 账户，也不需要安装或加载 `tsx`。
`meicode --init` 会创建 `~/.meicode/config.yaml`，如果配置已存在则不会覆盖。已有 `.mewcode` 目录会继续自动使用，无需立即迁移。
`meicode --doctor` 只读执行本地静态检查，不会调用模型。

MeiCode 是一个运行在终端里的命令行 AI 助手：可以直接操作文件系统、执行命令、搜索代码，通过 Skill 系统扩展能力，并内置**多智能体团队编排**——主会话可以派生专职专家成员（协程驻留、worktree 隔离），并行拆解复杂任务。

TypeScript / ESM / Node.js；终端 UI 基于 Ink + React，其余模块零框架依赖。

## 核心特性

### 1. Agent 主循环（`src/agent/loop.ts`）
- 完整工具调用循环：模型请求 → 工具执行 → 结果回流，支持流式输出与中断取消
- **上下文安全**：请求前 sanitize（防不完整 assistant(tool_calls) 引发 400）、超限自动压缩重试、spill 溢出落盘
- **防死循环**：重复工具调用检测（写类/命令分级阈值）
- **轮次管理**：剩余轮数提醒（报告优先）、团队任务进行中纯文本轮不判完成

### 2. 多智能体团队编排（`src/team/`）
- **协程驻留成员**：派生后长期驻留，独立上下文（history 落盘可恢复），邮箱协作（IDLE/PLAN/APPROVE 协议）
- **worktree 隔离**：每个成员独立 git worktree，写文件不污染主仓库；报告写契约目录、中间产物写共享区
- **专家角色**：内置 10 个通用开发角色，并支持按 frontmatter 扩展 max_rounds / write_paths / tools_allow
- **编排保障**：等待纪律（3 轮一查，防空转烧 token）、死亡感知（异常终止归 failed + ERR 邮件通知 Lead）、降级收尾（Lead 失联时自行汇总写报告）

### 3. Workflow 系统（`src/workflow/`）
- `.workflow.js` 声明式 DSL（`export const meta = { name, description, phases }`），项目级/用户级目录
- `/workflow create|validate|run|resume|cancel` + `/workflows` 运行记录——`run <名称> --team|--subagent` 显式选择后端，支持 phase 状态机、执行租约、自动恢复、产物 `artifacts/<runId>/<phase>.md`、JSON 持久化
- phase 可选 fork 子 agent 或 coroutine 团队成员两种后端

### 4. 权限与安全（`src/permission/`、`src/tools/`）
- 四级权限模式（default / edits / plan / yolo）+ 确认会话记忆
- **路径围栏**：成员写文件限 worktree 内，报告契约目录白名单；命令围栏防绕过（只读命令豁免、绝对路径/穿越拦截）
- 危险命令黑名单（11 类硬编码拦截 + 18 类风险提示）
- 快照/回滚（git tag 安全网）

### 5. 工具链
- 读写/编辑文件、执行命令（Windows/cmd 兼容提示）、代码搜索（grep/find）
- 浏览器自动化、MCP 客户端集成
- 子 Agent（spawn_agent + 10 个内置角色）、Hook 引擎（round_start/subagent_start 等）

## 性能优化（本地采样）

以下数字来自单机（Windows）调用链的**配对中位耗时对比**，量级为一次性的本地观测：
它说明的是"优化前后差多少"，**不是可复现的基准测试，也不构成性能承诺**。
实际收益会随磁盘、进程数、缓存状态和规则数量变化，复现时请以自己的采样为准。

- `grep_code` 全仓库无匹配搜索：中位耗时约降低 44%
- 运行时大参数事件写入：单次落盘耗时约降低 76%
- 团队锁短临界区竞争：获取锁中位延迟约降低 75%
- 权限 glob 规则匹配：复杂规则场景单次判断约降低 66%–93%
- 运行时事件重复读取：命中缓存时耗时约降低 17%
- 会话历史追加：每次追加减少一次文件元数据查询，配对采样约降低 7%

验证命令：

```bash
npm test
npm run package:smoke
```

## 快速开始

```bash
npm install
npm start          # 交互模式
npm start -- --run "任务描述"   # 无人值守模式
npm start -- --run "任务描述" --resume <会话ID>   # 显式恢复会话
npm start -- --run "任务描述" --yolo   # 显式放开危险操作
npm test           # 类型检查 + 全量测试
npm run test:fast  # 跳过慢测试，本地迭代用
npm run test:serial   # 排查并行测试问题
npm run lint       # 静态检查（CI 门禁，只拦 error）
npm run lint:fix   # 自动修复可修项
npm run format     # 按统一风格格式化
npm run metrics    # 重新统计项目规模（文档里的数字由此而来）
npm run verify     # lint + 全量测试（提交前跑这个）
```

`test:fast` 依据**最近 5 次实测耗时的中位数**判定慢测试（`test/.timings.json`，每次运行自动
回写并滑动窗口），因此会随机器和代码变化自动调整，且不会被单次卡顿或单次空载钉死；
尚无耗时记录时回退到 `scripts/test-tiers.mjs` 的人工清单。可用 `MEICODE_SLOW_MS` 调整阈值
（默认 5000ms）。

`scripts/test.mjs` 支持圈定范围，便于定向回归：

```bash
node scripts/test.mjs --tier fast             # 同 npm run test:fast
node scripts/test.mjs --filter permission     # 只跑文件名含 permission 的测试
node scripts/test.mjs --exclude team_         # 跳过文件名含 team_ 的测试
node scripts/test.mjs --list                  # 只列出将被执行的测试，不运行
```

测试会在 `test/` 下创建 `mkdtemp` 夹具；运行结束会自动回收，也可以手动执行
`npm run clean:fixtures`（保留仓库跟踪的 `test/fixtures_mcp`）。

### ACP / A2A 服务

ACP 默认只监听本机：

```bash
npm start -- --acp-port 8787
npm start -- --acp-port 8787 --acp-token "$MEICODE_ACP_TOKEN"
```

需要远程访问时必须同时显式指定 host 和 token：

```bash
npm start -- --acp-port 8787 --acp-host 0.0.0.0 --acp-token "$MEICODE_ACP_TOKEN"
```

ACP 达到会话上限时仅回收最久未使用的空闲会话；可用 `POST /session/:id/close` 主动关闭，正在运行的会话会先取消 Agent 并返回 `202`。

A2A 默认也只监听 `127.0.0.1`，可通过 `--a2a-token` 或 `MEICODE_A2A_TOKEN` 开启 Bearer 认证：

```bash
npm start -- --a2a-port 8788 --a2a-token "$MEICODE_A2A_TOKEN"
```

A2A 的 `maxActiveTasks` 仅限制未结束任务；已完成任务不占新建额度，仍按 `taskTtlMs` 保留历史。旧参数 `maxTasks` 继续兼容。

A2A Push 回调默认关闭。确需使用时，以 `--a2a-push-allow-url` 精确指定完整回调 URL（可重复）；服务端不会跟随回调重定向。例如：

```bash
npm start -- --a2a-port 8788 --a2a-token "$MEICODE_A2A_TOKEN" --a2a-push-allow-url http://127.0.0.1:9000/events
```

旧任务中的回调配置会保留；未列入当前允许列表的地址不会收到推送。

ACP/A2A 默认使用无人值守安全权限，限制危险命令和工作目录外写入，并启用上下文预算、自动压缩与大结果 spill。只有明确传入 `--yolo` 才会切换为宽松权限。

服务审计事件写入 `.meicode/runtime-events/`，普通文本日志写入 `.meicode/meicode.log`。审计事件包含 `requestId`、`agentId`、`taskId`、耗时、结束原因、配额拒绝和 Push 失败信息，不记录 token、请求正文或模型输出正文。

## 代码质量

三道门禁，全绿才算通过：

| 门禁 | 命令 | 内容 |
|---|---|---|
| 类型 | `npm run typecheck` | `tsc --noEmit` 严格模式，零错误 |
| 静态检查 | `npm run lint` | Biome，CI 只拦 error（含 `noFloatingPromises` / `noExplicitAny`） |
| 测试 | `node scripts/test.mjs` | 168 个入口文件、3,300+ 处断言 |

用 **Biome** 而不是 ESLint（或 typescript-eslint）的原因：本项目用 TypeScript 7（Go 版 `tsc`），
而 typescript-eslint 的 peer 范围仍停在 `>=4.8.4 <6.1.0`，TS 7 也尚未提供稳定的 compiler API——
官方给出的绕行方案是让 `typescript` 别名指向 TS 6，那会改动 `tsc` 的解析链，风险大于收益。
Biome 自带 TS 解析器、不依赖 TypeScript 编译器，因此对编译器大版本升级免疫，同时补齐了格式化能力。
逐条规则的取舍理由记在 `biome.jsonc` 顶部。

`lint` 的定位是**只挡回归、不管风格**：缩进/引号/分号一律不管，避免产生淹没真实问题的巨型 diff。

## 配置

复制 `config.example.yaml` 为 `~/.meicode/config.yaml`，配置 provider，并优先用 `api_key_env` 从环境变量读取密钥（支持 deepseek / kimi / qwen / bigmodel / mimo 模型目录）。

## 常用命令

```
/mode default|edits|plan|yolo   权限模式切换
/team create|spawn|assign|tasks|merge   团队编排
/workflow create|validate|run|resume|cancel   工作流（run 支持 --team/--subagent）
/session /compact /resume       会话管理
/audit [kind|task|request]      查询审计事件
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

## 项目规模

数字由脚本实时统计，不要手写——改完代码跑一遍即可更新：

```bash
npm run metrics
```

当前（统计口径见 `scripts/metrics.mjs` 顶部注释；行数随提交小幅变动，故用"约"）：

| 项目 | 规模 |
|---|---|
| 源码 | 161 个文件 / 约 2.4 万行 |
| 测试 | 168 个入口文件 / 约 3.6 万行 / 3,300+ 处断言 / 1,100+ 个具名用例 |
| 测试 : 源码 | ≈ 1.47 : 1（测试代码比源码多） |
| 内置角色 | 10 个 |
| 设计文档 | `docs/` 58 个文件 / 约 5,500 行 |
| 依赖 | 10 个运行时 / 7 个开发 |

## 许可

MIT
