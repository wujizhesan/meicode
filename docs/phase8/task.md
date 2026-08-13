# MewCode Phase8 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/memory/instructions.ts` | 指令三层加载 + @include |
| 新建 | `src/memory/session.ts` | 会话 JSONL 存档/恢复/清理 |
| 新建 | `src/memory/notes.ts` | 自动笔记 + 索引 |
| 新建 | `src/memory/index.ts` | 导出 |
| 修改 | `src/tui/useStream.ts` | 注入 + 存档 + 异步笔记 |
| 修改 | `src/cli.tsx` | 启动初始化 |
| 新建 | `test/memory_test.ts` | 全量测试 |

## T0: 指令加载

**文件：** `src/memory/instructions.ts`
**依赖：** 无
**步骤：**
1. 三层路径：`<cwd>/instructions.md`(3)、`<cwd>/.mewcode/instructions.md`(2)、`~/.mewcode/instructions.md`(1)
2. `loadInstructions(cwd)`：读存在的层，按优先级降序拼接（高在前，`\n\n---\n\n` 分隔）
3. `@include <path>` 解析：单独成行的 `@include` 指令 → 递归展开目标文件内容
   - visited 集合（文件路径）防环（重复跳过）
   - 深度 >5 停止
   - resolve 后路径必须落在 cwd 内（越界跳过 + console.warn）

**验证：** memory_test：三层拼接顺序（项目根内容在前）；@include 展开；环（A include B include A）不无限递归；深度超限截断；越界路径（../../x）跳过

## T1: 会话存档

**文件：** `src/memory/session.ts`
**依赖：** 无
**步骤：**
1. `newSessionId()`：`YYYYMMDD-HHMMSS-xxxx`（时间戳 + 4 位随机）
2. `append(messages)`：JSONL 追加写（每行 `JSON.stringify(msg)`）
3. `recoverLatest()`：
   - 扫描目录按文件名排序取最新
   - 逐行 parse（坏行 try/catch 跳过）
   - **截断**：从尾部回溯——`role:'tool'` 无前驱 assistant(tool_calls) 或无后续 tool 结果 → 截断到该轮前
   - 返回 `{ id, messages }`
4. `cleanup(days=30)`：mtime 超期删除，返回删除数

**验证：** memory_test：追加后文件行数正确；坏行（手写垃圾行）跳过；工具调用无结果截断；cleanup 删过期留新

## T2: 自动笔记

**文件：** `src/memory/notes.ts`
**依赖：** 无
**步骤：**
1. 笔记 Prompt：输出 JSON `{"notes":[{"category","title","content","action"}]}`；输入 = 现有索引 + 最近一轮；action create/update
2. `updateNotes(provider, recent, {userDir, projectDir})`：调 LLM（无 tools）→ JSON.parse → 写文件 `memory/<date>-<slug>.md`（frontmatter：category/date/title）；update 更新同名；parse 失败静默
3. `buildNotesIndex(userDir, projectDir)`：扫两目录 → 每笔记一行 `- [category] title — 首行摘要`；>200 行/25KB 截断

**验证：** memory_test：fake LLM 返回 JSON → 文件创建正确（frontmatter）；action=update 更新同名不新增；坏 JSON 静默；索引格式与截断

## T3: useStream 挂钩

**文件：** `src/tui/useStream.ts`
**依赖：** T0-T2
**步骤：**
1. 签名扩展：接收 `memoryCtx: { sessionStore?, instructions?, noteDirs? }`
2. send 前：`systemPrompt = buildPrompt(...) + '\n\n## 项目指令\n' + instructions + '\n\n## 记忆索引\n' + buildNotesIndex()`（索引每次 send 前读）
3. send 结束：记录 send 前 history 长度，结束后 diff 新消息 → sessionStore.append
4. done 且 reason=complete 且该轮无工具调用：`updateNotes(provider, 最近一轮, dirs).catch(() => {})`（异步不阻塞）

**验证：** tsc；tui_smoke 不崩（memoryCtx 可选）

## T4: cli 启动初始化

**文件：** `src/cli.tsx`
**依赖：** T3
**步骤：**
1. 创建 SessionStore（`<cwd>/.mewcode/sessions`）、loadInstructions、noteDirs（用户/项目 memory 目录 mkdir）
2. `cleanup()` + `recoverLatest()` → 填充 history（新 History 用恢复的消息）→ 日志提示「已恢复会话 <id>（N 条消息）」
3. memoryCtx 传给 App

**验证：** tsc；恢复路径：先跑一次会话（存档存在）→ 重启 → 提示恢复

## T5: 测试全量

**文件：** `test/memory_test.ts`、`test/tui_smoke.tsx`
**依赖：** T0-T4
**步骤：**
1. memory_test 全量（T0-T2 用例汇总）
2. tui_smoke 更新（App/useStream 新参数）
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P8 全部用例）

## T6: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T5
**步骤：**
1. 写一份项目 instructions.md（随便几句技术栈说明）→ 启动 → 问模型「项目用什么技术栈」→ 应能答出（指令生效）
2. 对话几轮 → 重启 → 应提示「已恢复会话」且历史在
3. 自然停几轮后 → 检查 `memory/` 目录出现笔记文件 + index.md

**验证：** 指令/恢复/笔记三条路径真机可用

## 执行顺序

```
T0/T1/T2（并行）→ T3 → T4 → T5 → T6
```

依赖链：T3 需 T0-T2；T4 需 T3；T5 需全部；T6 需 T5。
