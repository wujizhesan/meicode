# MewCode Phase4 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agent/prompt/modules.ts` | 七模块定义 |
| 新建 | `src/agent/prompt/rules.ts` | 关键规则（双重强化单一来源） |
| 新建 | `src/agent/prompt/environment.ts` | 环境信息 |
| 新建 | `src/agent/prompt/injection.ts` | 轮次注入策略 |
| 新建 | `src/agent/prompt/index.ts` | buildSystemPrompt + 注册表 + buildPrompt 兼容 |
| 删除 | `src/agent/prompt.ts` | 并入 prompt/ |
| 修改 | `src/agent/loop.ts` | 三段式消息组装 |
| 修改 | `src/provider/types.ts` | usage 事件加 cache 字段 |
| 修改 | `src/provider/openai.ts` | cache 字段解析 |
| 修改 | `src/tools/*.ts` | 六工具 description 对齐规则 |
| 修改 | `src/tui/useStream.ts` | 缓存命中率状态 |
| 修改 | `test/live_probe.ts` | 真机确认 cache 字段名 |
| 修改 | `test/loop_test.ts` | 前缀稳定/环境分流/轮次注入/双重强化断言 |
| 新建 | `docs/phase4/cache_eval.md` | 人工对比评估记录 |

## T0: 真机确认 cache 字段名（前置）

**文件：** `test/live_probe.ts`
**依赖：** 无
**步骤：**
1. 探针扩展：连续发两个相同请求（第二次应命中缓存），打印第二个响应 usage 的全部字段
2. 确认缓存字段名（预期 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，以实际为准）
3. 确认「相同前缀 + 增长历史」下缓存是否仍命中（模拟多轮：第一个请求 messages 3 条，第二个请求 messages 5 条共用前缀）

**验证：** 探针输出字段名与命中行为，写入 docs/phase4/cache_eval.md 开头

## T1: prompt 模块骨架

**文件：** `src/agent/prompt/{modules,rules,environment,injection,index}.ts`
**依赖：** T0
**步骤：**
1. rules.ts：KEY_RULES 三规则（preferTools / readBeforeEdit / retryOnFailure）
2. modules.ts：七模块（identity/constraints/task-mode/actions/tools/tone/output），内容从现有 SYSTEM_PROMPT 拆分并补全（P3 的模式命令说明进 task-mode；工具规则进 tools；「编辑前必先读」进 actions）
3. environment.ts：`buildEnvironmentInfo(ctx)` → cwd + 日期
4. injection.ts：`sessionDirective(mode, round)` → round 1 或 round%3===1 全量、否则精简（关键句）、null 语义
5. index.ts：`buildSystemPrompt(mode)` 按 priority 排序 + 空行拼装；`buildPrompt(mode)` 兼容签名调新函数

**验证：** tsc；node 脚本调用 buildSystemPrompt('full') 输出含七模块内容且顺序正确、空行分隔

## T2: loop.ts 三段式组装

**文件：** `src/agent/loop.ts`
**依赖：** T1
**步骤：**
1. 每轮 messages 组装：主 system（buildSystemPrompt(mode)）+ 环境 system（buildEnvironmentInfo(ctx)）+ 轮次 system（sessionDirective(mode, round)，null 则跳过）+ history
2. 主 system 内容与轮次无关（每轮同一字符串）
3. 删除对旧 prompt.ts 的引用

**验证：** tsc；loop_test 加断言（见 T6）

## T3: provider cache 字段

**文件：** `src/provider/types.ts`、`src/provider/openai.ts`
**依赖：** T0（字段名）
**步骤：**
1. types.ts：usage 事件加 `cacheHitTokens?` / `cacheMissTokens?`
2. openai.ts：usage chunk 解析时读 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（按 T0 确认的字段名；缺失则 undefined）
3. smoke.ts：fake usage chunk 含 cache 字段 → 事件携带正确；不含 → undefined

**验证：** tsc + smoke 新用例

## T4: 工具 description 双重强化

**文件：** `src/tools/read_file.ts`、`write_file.ts`、`edit_file.ts`、`run_command.ts`、`find_files.ts`、`grep_code.ts`
**依赖：** T1（rules.ts 措辞）
**步骤：**
1. 核对六工具 description 是否体现 KEY_RULES 语义：
   - 读类工具：强化「供后续编辑/修改前使用」
   - edit_file：description 含「编辑前必先读」语义 + 失败重试提示
   - 全工具：失败信息结构化可重试
2. 措辞与 rules.ts 对齐（关键词一致）

**验证：** loop_test 断言：edit_file/read_file 的 description 含「读」类关键词；测试全绿

## T5: UI 缓存命中率

**文件：** `src/tui/useStream.ts`
**依赖：** T3
**步骤：**
1. useStream 累计 cacheHitTokens/cacheMissTokens（usage 事件可选字段）
2. 状态行显示：`缓存 X%`（hit/(hit+miss)）；无数据不显示

**验证：** tsc；TUI 快照不崩

## T6: 测试与回归

**文件：** `test/loop_test.ts`
**依赖：** T1-T5
**步骤：**
1. 前缀稳定：fake provider 捕获每轮 messages——连续两轮主 system 消息字节一致（深度比较）
2. 环境分流：主 system 不含 cwd 路径；环境 system 含 cwd
3. 轮次注入：fake provider 每轮都调工具（跑 5 轮）→ 断言第 1 轮注入全量、第 2/3 轮精简、第 4 轮全量
4. 双重强化：edit_file 工具 description 含关键规则关键词
5. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P4 全部用例）

## T7: 真机对比评估

**文件：** `docs/phase4/cache_eval.md`
**依赖：** T6
**步骤：**
1. 真机跑 `npm start`，连续多轮对话（≥3 轮）观察缓存命中率显示
2. 同一任务对比记录：结构化前后响应速度与 token 费用（P3 prompt vs P4 模块化）
3. 结果写入 cache_eval.md

**验证：** 命中率 >0 且随轮次上升（同前缀复用）；对比数据记录完成

## 执行顺序

```
T0（前置）→ T1 → T2 ─→ T5 → T6 → T7
                    T3 ─┘
T4（可并行，依赖 T1）─────┘
```

依赖链：T2 需 T1；T3 需 T0；T5 需 T3；T6 需全部；T7 需 T6。
