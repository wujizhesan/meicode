# MewCode Phase3 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agent/events.ts` | AgentEvent/StopReason/AgentOptions/AgentHandle/AgentResult |
| 新建 | `test/live_probe.ts` | 真机冒烟探针（T0） |
| 重写 | `src/agent/loop.ts` | runAgent：ReAct 循环 + 停止条件 + 分批执行 |
| 扩展 | `src/agent/prompt.ts` | PLAN_SYSTEM_PROMPT + buildPrompt |
| 修改 | `src/provider/types.ts` | StreamEvent 加 usage |
| 修改 | `src/provider/openai.ts` | include_usage 请求 + usage 解析 |
| 修改 | `src/tools/run_command.ts` | 移除确认强制 |
| 重写 | `src/tui/useStream.ts` | AgentEvent → UI 映射 + cancel/isRunning/模式 |
| 修改 | `src/tui/App.tsx` | /plan /do 识别 + Ctrl+C 语义 + 模式显示 |
| 重写 | `test/loop_test.ts` | 五类停止 + 分批并发 + Plan Mode 断言 |
| 修改 | `test/smoke.ts` | usage 解析测试 |

## T0: 真机冒烟（前置，AC9）

**文件：** `test/live_probe.ts`
**依赖：** 无（用现有 P2 代码）
**步骤：**
1. 写探针脚本：加载 `~/.mewcode/config.yaml`，直连 DeepSeek 发两个请求：
   a. 带 `stream_options: {include_usage: true}` + tools 的普通提问 → 记录：是否 400、usage chunk 是否出现
   b. 带 tools 问「读一下 D:\MewCode\package.json」→ 记录：模型是否调用工具、调用格式
2. 脚本输出行为报告（兼容性结论），不写死断言
3. **运行需要用户 key**——直接运行（配置在 `~/.mewcode/config.yaml`），结果记录到 `docs/phase3/live_probe.md`

**验证：** 报告明确回答两个问题：① include_usage 是否兼容（兼容→T2 保留；不兼容→去掉该字段降级）② 模型工具调用行为（正常→继续；异常→先查原因再开发）

## T1: agent 事件与类型

**文件：** `src/agent/events.ts`、`src/provider/types.ts`
**依赖：** T0 结论
**步骤：**
1. events.ts：AgentEvent 联合类型、StopReason、AgentOptions、AgentHandle、AgentResult（按 plan 定义）
2. provider/types.ts：StreamEvent 加 `{ type: 'usage'; inputTokens; outputTokens }`

**验证：** tsc 通过

## T2: provider include_usage

**文件：** `src/provider/openai.ts`、`test/smoke.ts`
**依赖：** T1（按 T0 结论：兼容则加，不兼容则跳过 usage 字段但保留类型）
**步骤：**
1. 请求体加 `stream_options: { include_usage: true }`（T0 确认兼容时）
2. 流式解析：`data.usage`（choices 为空数组的最终 chunk）→ yield `{type:'usage'}` 事件；usage 出现在 [DONE] 前
3. smoke.ts 加 fake 测试：SSE 含 usage chunk → 事件序列含 usage 且数值正确；不含 usage 的流不产生 usage 事件

**验证：** tsc + smoke 新用例绿

## T3: runAgent 主循环

**文件：** `src/agent/loop.ts`
**依赖：** T1、T2
**步骤：**
1. 重写为 `runAgent(opts): AgentHandle`——handle 含 `events`（AsyncIterable，内部队列 + 消费者）、`cancel()`（AbortController）、`done`（Promise）
2. 主循环（round 1..maxIterations）：
   - 每轮：`provider.streamChat(messages, {thinking, tools(按 mode 过滤)})`，双路（onEvent 转发给 events + 内部攒 roundText/roundCalls/usage）
   - 停止检查顺序：aborted → cancelled；roundCalls 空 → complete；全未知且 streak≥limit → unknown_tool；流 error → error；round 超限 → max_iterations
3. 历史维护：assistant(tool_calls) / tool 消息回写 / 最终 assistant 回复
4. 事件顺序：progress → text/thinking/tool_call → tool_result → usage →（下一轮 progress）→ done

**验证：** tsc；loop_test 逐步补（见 T8），本任务先保证 fake provider 单轮/两轮行为与 P2 等价

## T4: 多工具分批执行

**文件：** `src/agent/loop.ts`
**依赖：** T3
**步骤：**
1. `READ_TOOLS = {read_file, find_files, grep_code}` 并发（Promise.all）；其余串行（for 循环）
2. 结果按原始 calls 顺序合并回写 tool 消息
3. 未知工具计数：本轮全未知 → streak++；否则 streak=0；≥limit 停止
4. 分批执行在事件流中按「实际执行完成顺序」发 tool_result（并发组完成顺序不定，UI 以 id 区分）

**验证：** loop_test：fake 同批 2 读 → 并发（时间重叠断言，两个读工具各 sleep 100ms，总耗时 <190ms）；1 读 + 1 写 → 串行（写开始时间 > 读结束时间）；连续 2 次未知工具 → unknown_tool 停止；第 3 次合法 → 计数清零

## T5: prompt 扩展

**文件：** `src/agent/prompt.ts`
**依赖：** 无
**步骤：**
1. `PLAN_SYSTEM_PROMPT`：计划模式提示——「你处于计划模式，只能用读类工具（read_file/find_files/grep_code），输出步骤化计划，不要修改文件或执行命令」
2. `buildPrompt(mode, planContext?)`：full 模式返回 SYSTEM_PROMPT；plan 模式返回 PLAN_SYSTEM_PROMPT；planContext 存在时在 full 基础上追加「你已制定计划：…，请按计划执行」

**验证：** tsc；loop_test 断言 buildPrompt 各模式内容含/不含关键词

## T6: useStream 重写

**文件：** `src/tui/useStream.ts`
**依赖：** T3、T5
**步骤：**
1. 删除 send 内循环逻辑，改为：`send(text)` → 调 runAgent → 订阅 events → 逐事件 setState
2. 事件映射：text/thinking → 占位追加；tool_call → 「🔧 调用工具」行；tool_result → tool 行（成功/失败摘要）；progress → 步数状态；usage → 累计 token；done → 停止原因收尾
3. 暴露：`cancel()`、`isRunning`、`mode`、`setMode('plan'|'full')`、`planText`（/plan 产出缓存，/do 时取用）
4. /do 时：把缓存 planText 作为 planContext 传入 runAgent，并带原始问题重新 send

**验证：** tsc；tui_smoke 快照仍含就绪提示

## T7: App/Input 与命令语义

**文件：** `src/tui/App.tsx`、`src/tui/Input.tsx`、`src/tools/run_command.ts`
**依赖：** T6
**步骤：**
1. Input 提交识别：`/plan` → setMode('plan')（提示「计划模式：仅读类工具，输出计划后输 /do 执行」）；`/do` → setMode('full') + 用缓存 planText 重新 send；其他 → send
2. App 显示模式标记：输入行前缀 `[Plan]` / `[Full]`
3. Ctrl+C：isRunning → cancel()（显示「已取消，正在停止…」）；空闲 → process.exit(0)
4. run_command.ts：删除 `if (ctx.confirm) {...}` 强制逻辑（confirm 为 undefined 时直接执行）——只保留参数校验

**验证：** tsc；tui_smoke 更新（App props 变化）；TTY 下手动验证 /plan 切换（checklist）

## T8: 测试全量

**文件：** `test/loop_test.ts`、`test/smoke.ts`、`test/tui_smoke.tsx`
**依赖：** T3-T7
**步骤：**
1. loop_test 重写：五类停止条件各一用例（complete/max_iterations/cancelled/unknown_tool/error）+ 分批并发/串行 + 计数清零 + Plan Mode tools 过滤断言（fake provider 捕获请求 tools）
2. smoke.ts：usage 解析用例（T2 已加）
3. tui_smoke.tsx：更新 App props

**验证：** `npx tsc --noEmit` 0 错误；`npm test` 全绿（含 Phase1/2 回归）

## T9: 真机端到端（用户配合）

**文件：** 无（验证）
**依赖：** T8
**步骤：**
1. 用户 `npm start` 真机跑 AC1：问「创建 hello.txt 写入『你好 MewCode』再读回来」→ 观察多轮自主循环
2. 验证 AC8：进度显示（步数/token/停止原因）
3. 验证 /plan /do 流程
4. 结果记录进验收报告

**验证：** 场景通过 = AC1/AC7/AC8 达成

## 执行顺序

```
T0（真机冒烟，前置）→ T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9
```

T4 依赖 T3；T6 依赖 T3+T5；T7 依赖 T6；T5 独立可并行。
