# MewCode Phase11 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/hook/types.ts` | HookRule/事件/条件/动作/上下文 |
| 新建 | `src/hook/matcher.ts` | 条件匹配（精确/!/正则/glob/all-any） |
| 新建 | `src/hook/loader.ts` | YAML 加载 + 校验 |
| 新建 | `src/hook/runner.ts` | 动作执行（command/inject/http/subagent） |
| 新建 | `src/hook/engine.ts` | HookEngine（fire/intercept/once/缓冲） |
| 修改 | `src/agent/loop.ts` | round/tool 事件挂钩 |
| 修改 | `src/tui/useStream.ts` | message 事件 |
| 修改 | `src/cli.tsx` | 加载 + 生命周期事件 |
| 新建 | `test/hook_test.ts` | 全量测试 |

## T0: 类型与匹配器

**文件：** `src/hook/types.ts`、`src/hook/matcher.ts`
**依赖：** 无
**步骤：**
1. types.ts：HookEventName / HookClause / HookCondition / HookAction / HookRule / HookContext
2. matcher.ts：
   - `matchPattern(value, pattern)`：`!` 前缀反向；`/re/` 正则（非法返回 false）；含 `*` minimatch；否则精确
   - `getPath(data, 'args.command')`：点路径深层取值
   - `matchCondition(data, cond)`：all 全部满足 / any 任一满足

**验证：** hook_test：精确/反向/正则/glob 各用例；all 全真才真、any 一真即真；`args.command` 深层取值

## T1: 加载器

**文件：** `src/hook/loader.ts`
**依赖：** T0
**步骤：**
1. 路径：项目 `<cwd>/.mewcode/hooks.yaml` + 用户 `~/.mewcode/hooks.yaml`（项目覆盖用户，规则合并）
2. 校验：event 合法、action.type 合法且字段完整（command→command、http→url、inject→content）；**tool_before 配 async → 报错**；坏规则 skipped + console.warn
3. 返回 `{ rules, skipped }`

**验证：** hook_test：合法加载；缺 event/action 跳过；tool_before+async 报错；两层合并（项目覆盖）

## T2: 执行器与引擎

**文件：** `src/hook/runner.ts`、`src/hook/engine.ts`
**依赖：** T0、T1
**步骤：**
1. runner：runCommand（spawn + Windows shell + 10s 默认超时，输出 warn）、runHttp（fetch fire-and-forget，失败 warn）、runInject（返回 content）、runSubagent（占位日志）
2. engine：
   - fire(event, ctx)：遍历该事件规则 → once 检查（fired 标记）→ matchCondition → 动作执行（async 不 await；全 try/catch）
   - intercept(call, cwd)：tool_before 规则命中第一条 → 返回 `[Hook 拦截] <描述>`；未命中 null
   - collectInjections/resetRound：inject 缓冲

**验证：** hook_test：once 同会话不重复；async 不阻塞（时序）；超时杀命令；http 发出（fake server）；subagent 占位；失败不中断（后续事件仍触发）；intercept 命中/未命中

## T3: loop 挂钩

**文件：** `src/agent/loop.ts`
**依赖：** T2
**步骤：**
1. round 开始：`await ctx.hooks?.fire('round_start', { round })` + `collectInjections()` → msgs 加独立 system 消息
2. executeOne：权限裁决后 → `ctx.hooks?.intercept(call)` → 命中返回 `[Hook 拦截]` 结果
3. executeBatch 后：`fire('tool_after', { call })`
4. round 结束：`fire('round_end')` + `resetRound()`

**验证：** loop_test：hooks 注入（fake 断言 msgs 含注入 system）；intercept 拦截回灌；回归

## T4: useStream/cli 挂钩

**文件：** `src/tui/useStream.ts`、`src/cli.tsx`
**依赖：** T2
**步骤：**
1. useStream：send 结束后 `fire('message', { message: 新消息 })`；ctx.hooks 注入
2. cli：loader 加载 → HookEngine → app_start/session_start fire；退出时 session_end/app_exit

**验证：** tsc；tui_smoke 不崩

## T5: 测试全量

**文件：** `test/hook_test.ts`、`test/loop_test.ts`
**依赖：** T0-T4
**步骤：**
1. hook_test 全量（T0-T2 用例）
2. loop_test 挂钩用例（T3 已加）
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P11 全部用例）

## T6: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T5
**步骤：**
1. 写 `.mewcode/hooks.yaml`：round_start 注入「每轮先确认测试」+ tool_before 拦截 `run_command` 的 `del *`
2. 启动 → 对话 → 注入可见；让模型执行 del 命令 → 被 `[Hook 拦截]` 挡住
3. 失败隔离：写一条坏 hook（命令超时）→ Agent 正常运行

**验证：** 注入/拦截/失败隔离三条路径

## 执行顺序

```
T0 → T1 → T2 → T3/T4 → T5 → T6
```

依赖链：T1 需 T0；T2 需 T0+T1；T3 需 T2；T4 需 T2；T5 需全部；T6 需 T5。
