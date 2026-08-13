# MewCode Phase3 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] runAgent 五类停止条件（验证：loop_test 各一用例——complete / max_iterations / cancelled / unknown_tool / error）
- [ ] 多工具分批执行（验证：2 读并发时间重叠；读+写串行；结果按原始顺序回写）
- [ ] 未知工具连续计数（验证：连续 2 次停止；任一合法轮清零）
- [ ] 事件流完整（验证：一轮含 tool_call 的循环产生 text→tool_call→tool_result→usage→done 序列）
- [ ] Plan Mode tools 过滤（验证：fake provider 捕获请求——plan 模式仅 3 个读类工具，full 模式 6 个）
- [ ] usage 解析（验证：fake SSE 含 usage chunk → usage 事件数值正确）

## 集成

- [ ] useStream 事件映射（验证：tui_smoke 快照正常；事件驱动渲染不崩）
- [ ] /plan /do 切换（验证：TTY 下输入 /plan 出现模式提示与 [Plan] 标记；/do 切回并注入计划）
- [ ] Ctrl+C 语义（验证：循环中 cancel 显示「已取消」，进程不退出；空闲时退出）
- [ ] run_command 自主执行（验证：tools_test 确认无 confirm 也执行）
- [ ] 纯对话回归（验证：无工具调用单轮完成，Phase1/2 用例全绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（Phase1 + Phase2 + Phase3 全部用例）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 多步自主：问「创建 hello.txt 写入『你好 MewCode』再读回来」→ 一次提问内自主完成写入+读取，UI 显示多轮 🔧 工具行与结果，无用户介入
- [ ] 场景 2 · 进度显示：循环中看到 `[N/15]` 步数与累计 token；结束显示停止原因
- [ ] 场景 3 · Plan Mode：输入 `/plan` → 出现 [Plan] 标记，问「分析一下 src/tools 的结构」→ 模型用读类工具出计划；输入 `/do` → 切 [Full]，按计划执行
- [ ] 场景 4 · 用户取消：循环进行中按 Ctrl+C → 显示「已取消」，干净停止不退出；再按 Ctrl+C 退出

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 多步自主完成 | 端到端场景 1 |
| AC2 迭代上限 | 实现完整性第 1 条（loop_test max_iterations） |
| AC3 用户取消 | 集成第 3 条 + 端到端场景 4 |
| AC4 未知工具停止 | 实现完整性第 3 条 |
| AC5 流错误停止 | 实现完整性第 1 条（error） |
| AC6 多工具分批 | 实现完整性第 2 条 |
| AC7 Plan Mode | 实现完整性第 5 条 + 场景 3 |
| AC8 进度显示 | 场景 2 |
| AC9 真机冒烟前置 | T0 完成记录（live_probe.md） |
