# Changelog

## 0.1.7 (2026-11-11)

- `tasks/list` 支持 `query` 参数：按任务正文（用户与助手消息）做大小写不敏感匹配，最多扫描 500 条历史任务；空查询等价于不过滤
- A2A 支持跨任务续聊：请求头 `x-meicode-context-history: 1` 时，新任务会把同 `contextId` 下已有任务的消息（最近 200 条）按顺序灌进模型上下文；不带该头仍是全新对话，老客户端行为不变。此前每次 `message/send` 都只带当前这一条消息，多轮对话在服务端其实是无记忆的
- A2A 工具事件补上正文输出：`meicode/tool` 的 end 帧新增 `output`（工具层已截到 8KB，服务端再兜一层），Web 控制台据此把「成功」展开成可读结果
- A2A 交互审批：请求头 `x-meicode-interactive: 1` 时权限询问不再默认拒绝，改为下发 `meicode/ask` 事件，客户端用 JSON-RPC `meicode/approval` 回传 `once` / `session` / `deny` 后继续执行；120 秒未答复或断流一律按拒绝处理。审批等待单独计入 `waitedMs`，不再污染工具耗时
- `edit_file` / `write_file` 的结果新增 `diff`（unified diff）：编辑前后对比在工具层算好，随 `tool_result` 事件透传给 A2A 的 `meicode/tool` 帧，Web 控制台据此渲染红绿对比。新增 `src/tools/diff.ts`（行级 LCS，带上下文与截断，超大文件退化为整段替换）
- A2A 新增工具事件通道：请求头带 `x-meicode-tool-events: 1` 时，每次工具调用会额外推送两帧 `meicode/tool` artifact（start 含工具名与参数摘要、end 含成败/耗时/结果摘要），供前端渲染工具卡片；未声明该头的请求产物形态与之前完全一致
- 收窄文件锁的瞬时错误判据：锁文件与票据路径只把 `ENOENT` / `EPERM` / `EBUSY` 当作可重试的竞态，`EACCES` 改回如实失败。0.1.5 曾把 `EACCES` 一并纳入重试，那会让真实的权限错误被掩盖成一个超时，四平台 CI 上的失败也源于此
- README 首屏重构：把项目定位提到标题下，新增「五分钟上手」（安装 → 配置 → `--doctor` 静态自检 → 跑第一个任务 → 下一步），原「快速开始」改为「开发命令」并明确区分使用者与开发者；规模数字按 `npm run metrics` 实测刷新（源码 162 文件 / 24,629 行，测试 173 入口 / 3,350 断言）
- 发版说明：本版源码、`dist/` 与公开仓库均已包含上述四项 A2A 扩展。
  npm registry 发布单独完成；在 `@wujizhesan/meicode` 的 `latest` 指向 `0.1.7` 之前，
  `npm i -g` 装到的仍是 `0.1.6`，四项扩展不可用，请以 npm 的 `dist-tags` 为准确认。
  前端 README 的「服务端版本要求」下限待 npm 发布后同步更新
- 发版绕路说明：GitHub Actions 被账户账单限制拦住（job 一律 `startup_failure`），
  Trusted Publishing 的自动发版链路不可用。本版改为本地 `npm pack` + 手工 `gh release create`
  分发 tgz；npm publish 需包维护者本人登录后执行

## 0.1.6 (2026-11-03)

- 发版自动化：推送 `v*` 标签触发 `.github/workflows/release.yml`，跑 lint + 全量测试 + 打包冒烟后再发布，并自动创建带 tgz 资产的 GitHub Release（原来是手动 workflow_dispatch + 手工发布）
- npm 发布改用 Trusted Publishing（GitHub OIDC）：仓库与 CI 里不再存放任何 npm token，规避 2027-01 起 bypass-2FA token 不能直接发布的限制
- 私有仓库不生成 provenance（npm 已知限制），工作流显式 `NPM_CONFIG_PROVENANCE=false`，避免发布阶段因来源证明失败
- `repository` 指向私有仓库、`homepage` 指向 npm 包页面

## 0.1.5 (2026-11-03)

- 包名改为 `@wujizhesan/meicode`：npm 以「与既有包 `keycode` 过于相似」为由拒绝发布 `meicode`，改为 scoped 发布；CLI 命令名仍是 `meicode`，安装命令变为 `npm i -g @wujizhesan/meicode`
- 接入 Biome 作为静态检查与格式化门禁（`npm run lint` / `lint:fix` / `format`），CI 新增独立 lint job（与平台无关，只跑一次；只拦 error）
- 新增 `scripts/metrics.mjs` 与 `npm run metrics`：项目规模改由脚本实时统计，修正 README / INTERVIEW 中与代码树严重脱节的数字（原文写"35 个测试文件"，实际 168 个）
- 修复 lint 拦下的问题：把刻意的 fire-and-forget 显式标记为 `void`（`trackRun` / `stream.send` / 测试里的 `check`）、补齐 4 处隐式 any 的变量类型、测试夹具清理的目录守卫前移到创建处以避免 finally 抛错遮蔽真实断言失败
- 清理未使用的导入与一处不可达代码（桩 provider 里 `throw` 之后的 `yield`，改为逐点抑制并注明理由）；随后把剩余告警一并清零——`npm run lint` 从 58 警告降到仅剩 9 处有意保留为 warn 的 React 依赖数组（`useExhaustiveDependencies`，补依赖可能引发重渲染循环，需人工判断）
- lint 配置明确关掉两条会**帮倒忙**的规则并写明理由：`useLiteralKeys`（测试用 `obj['privateField']` 绕过 TS 私有可见性断言内部状态，自动改成点号会把编译跑挂）、`noConfusingVoidType`（`X | void` 是"回调可以不返回"的有意契约）；`noTemplateCurlyInString` 仅在 `test/**` 放宽——那里的 `${...}` 几乎都是被测系统的运行时模板占位符，必须是字面量
- `test:fast` 的慢测试判据从「历史最小耗时」改为「最近 5 次耗时的中位数」并滑动窗口：最小值只降不升，测试退化后会被永久留在 fast 层；中位数最多 5 次运行即可反映真实变化，且不被单次卡顿或空载带偏。旧的单数字缓存自动迁移
- 加固两个负载敏感的回归用例，消除「机器一忙 CI 就间歇性红」：`a2a_limits_test` 把未来时间戳偏移从 500ms 放大到 5s、固定 sleep 改为按墙钟轮询、阻塞段完成轮询由 50×10ms 改为带明确失败的长超时；`team_completion_hook_test` 把迟到写入 / hook 超时提为 6s / 12s 常量（必须保持「迟到 < 超时」，否则子进程会被超时兜底杀掉而假通过），并把 2.5s 死线放宽到 15s
- 修复 Windows 上并发加锁偶发的 `EPERM mkdir *.lock.queue`：队列目录被其他持有者清理时，递归建目录还会撞上「目录句柄尚未释放」，此前只重试 `ENOENT`，现按 `ENOENT`/`EPERM`/`EACCES`/`EBUSY` 一并重试，仍由 deadline 兜底
- 测试不再依赖 `ping` 制造长耗时命令：新版 `ubuntu-latest` 运行器禁止 ICMP 原始套接字，`ping` 会立刻以退出码 2 结束，导致超时/取消用例失真（两个红、一个假通过）。改用 `process.execPath` 跑 `setTimeout` 睡眠，跨平台且不依赖网络能力

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
