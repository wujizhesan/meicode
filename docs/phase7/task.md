# MewCode Phase7 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/context/estimate.ts` | TokenEstimator（锚点+增量） |
| 新建 | `src/context/spill.ts` | 工具结果存盘（单条/批次） |
| 新建 | `src/context/summary.ts` | LLM 摘要 + 边界消息 + tailKeep |
| 新建 | `src/context/manager.ts` | ContextManager（触发+熔断） |
| 新建 | `src/context/index.ts` | 导出 |
| 修改 | `src/session/history.ts` | replaceRange |
| 修改 | `src/tools/types.ts` | ToolContext 扩展 |
| 修改 | `src/agent/loop.ts` | spill/请求前/请求后挂钩 |
| 修改 | `src/tui/useStream.ts` | manager 创建 + 挂钩注入 |
| 修改 | `src/tui/App.tsx` | /compact 命令 |
| 修改 | `src/config/{types,loader}.ts` | context_window |
| 新建 | `test/context_test.ts` | 全量测试 |

## T0: 估算器

**文件：** `src/context/estimate.ts`
**依赖：** 无
**步骤：**
1. TokenEstimator：`estimate(messages)`（锚点后增量字符/4；无锚点全量）、`update(usageInputTokens, count)`
2. 增量 = messages.slice(anchorCount) 的字符数合计 / 4

**验证：** context_test：锚点后新增 400 字符 → 估算增量 ≈100；无锚点全量估算；update 后锚点刷新

## T1: 存盘

**文件：** `src/context/spill.ts`、`src/session/history.ts`
**依赖：** 无
**步骤：**
1. `spillContent(content, dir)`：>4KB 写 `<dir>/spill_<ts>_<n>.txt`（mkdir recursive），返回相对路径
2. `spillBatch(results, dir)`：合计 >8KB 时按大小降序 spill 直到合计 ≤8KB；返回替换后的 content 数组
3. 替换格式：`[已存盘] ${preview 200}…\n完整内容: ${relPath}`
4. history.ts：`replaceRange(start, end, messages)`

**验证：** context_test：5KB 内容存盘文件完整、返回内容含 [已存盘]+预览+路径；批次 3 结果合计超限挑大存盘；replaceRange 行为

## T2: 摘要

**文件：** `src/context/summary.ts`
**依赖：** T0（估算用于 tailKeep）
**步骤：**
1. SUMMARY_SYSTEM（禁工具/草稿后正式/五部分）
2. BOUNDARY_MESSAGE 常量
3. `tailKeep(messages, keepTokens=10000, minCount=5)`：从尾部往回累加（字符/4），保留 ≥minCount 条
4. `summarize(provider, earlyMessages, ctx)`：独立 streamChat（thinking false、无 tools）收集全文；异常 throw

**验证：** context_test：tailKeep 尾部 5 条/1 万 token 保留；summarize 用 fake provider 捕获请求断言无 tools 参数；摘要文本收集正确

## T3: manager

**文件：** `src/context/manager.ts`
**依赖：** T0-T2
**步骤：**
1. ContextManager：beforeRequest('auto'|'manual')：
   - spill 兜底扫描（history tool 消息 >4KB 且未含 [已存盘] → 替换）
   - 估算 > window - margin → summarize(早期 drop) → replaceRange([摘要, 边界]) 
   - 失败 failCount++；≥3 熔断（auto 模式不再触发，manual 绕过）
   - 成功清零 failCount
2. afterRequest(usage, count)：更新估算锚点
3. 摘要消息格式：`以下为早期对话摘要（<日期>）：\n<摘要>`

**验证：** context_test：小窗口（如 3000）配置下逼近即触发摘要；早期被替换、边界消息出现、尾部保留、用户消息原文；失败 3 次熔断；manual 绕过；成功清零

## T4: loop 挂钩与 ToolContext

**文件：** `src/tools/types.ts`、`src/agent/loop.ts`
**依赖：** T3
**步骤：**
1. ToolContext 加：`spill?`、`beforeRequest?`、`afterRequest?`
2. loop executeBatch 回灌前：ctx.spill 存在 → spillBatch(results) 替换 content
3. loop 每轮 streamChat 前：`await ctx.beforeRequest?.('auto')`
4. loop usage 事件后：`ctx.afterRequest?.(usageTokens, history.length)`

**验证：** loop_test 加：fake 大工具结果 → 回灌内容含 [已存盘]；beforeRequest 被调用（fake ctx 断言）

## T5: TUI 与配置

**文件：** `src/tui/useStream.ts`、`src/tui/App.tsx`、`src/config/{types,loader}.ts`
**依赖：** T4
**步骤：**
1. config：ProviderConfig 加 `context_window?`；loader 透传
2. useStream：创建 ContextManager（spillDir = `<cwd>/.mewcode/artifacts`，window = cfg.context_window ?? 131072）；ctx 注入 loop 挂钩
3. App：`/compact` 命令 → manager.beforeRequest('manual') → 界面提示结果

**验证：** tsc；tui_smoke 不崩；/compact 命令路径存在

## T6: 测试全量

**文件：** `test/context_test.ts`、`test/loop_test.ts`
**依赖：** T0-T5
**步骤：**
1. context_test 全量：估算/存盘/批次/摘要/触发/保留/边界/熔断/手动/用户消息保留
2. loop_test 挂钩用例（T4 已加）
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P7 全部用例）

## T7: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T6
**步骤：**
1. 长对话（多轮工具调用产生大结果）→ 观察工具结果存盘（artifacts 目录出现文件）
2. 调小配置 `context_window: 5000`（临时）→ 多轮后自动摘要触发，早期消息被摘要替换
3. `/compact` 手动压缩
4. 配置还原

**验证：** 存盘/摘要/手动三条路径真机可用

## 执行顺序

```
T0/T1/T2（并行）→ T3 → T4 → T5 → T6 → T7
```

依赖链：T3 需 T0-T2；T4 需 T3；T5 需 T4；T6 需全部；T7 需 T6。
