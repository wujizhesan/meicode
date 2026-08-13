# MewCode Phase9 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/commands/types.ts` | CommandDef/UiController/CommandType |
| 新建 | `src/commands/registry.ts` | 注册中心（冲突/查找/补全） |
| 新建 | `src/commands/parser.ts` | 斜杠解析器 |
| 新建 | `src/commands/builtin.ts` | 十内置命令 |
| 新建 | `src/commands/index.ts` | createDispatcher |
| 修改 | `src/tui/App.tsx` | 分流 + UiController + 补全菜单 |
| 修改 | `src/tui/Input.tsx` | Tab 捕获 |
| 修改 | `src/tui/useStream.ts` | clearHistory/newSession 暴露 |
| 修改 | `src/cli.tsx` | registry 构造 + 冲突 catch |
| 新建 | `test/commands_test.ts` | 全量测试 |

## T0: 类型与注册中心

**文件：** `src/commands/types.ts`、`src/commands/registry.ts`
**依赖：** 无
**步骤：**
1. types.ts：CommandType / CommandDef / UiController / ParsedCommand
2. registry.ts：register（name+aliases 冲突 throw）、find（小写）、list(includeHidden)、complete（hidden 排除）

**验证：** commands_test：登记 3 命令 → find 命中/未命中；别名冲突 register 抛错；complete 前缀匹配 + 隐藏排除

## T1: 解析器

**文件：** `src/commands/parser.ts`
**依赖：** T0
**步骤：**
1. parseCommandLine：非 `/` 开头 → null；纯 `/` 或空白 → null；`/NAME args` → name 小写 + args split

**验证：** commands_test：`/HELP x y` → help + [x,y]；`/` 和空 → null；`你好` → null；`/compact` → compact + []

## T2: 内置命令

**文件：** `src/commands/builtin.ts`
**依赖：** T0
**步骤：**
1. 十命令定义（help/compact/clear/plan/do/session/memory/permission/status/review），类型与行为按 spec 命令表
2. session 的 aliases: ['resume']
3. 用 mock UiController 可测试

**验证：** commands_test：mock ui 断言各命令 handler 调用：/clear → clearHistory；/plan 带参 → setMode + sendUserMessage；/review → sendUserMessage 一次含 git；/session → sessionAction('list')；/do → setMode('default')

## T3: 分流器

**文件：** `src/commands/index.ts`
**依赖：** T1、T2
**步骤：**
1. createDispatcher(registry, ui)：dispatch（parse null → false；find → handler → true；未找到 → showMessage /help 引导 → true）+ complete

**验证：** commands_test：`/status` → true 且 ui 收到；`你好` → false；`/未知命令` → true + showMessage 含 /help

## T4: useStream 方法扩展

**文件：** `src/tui/useStream.ts`
**依赖：** 无
**步骤：**
1. 暴露 `clearHistory()`（history.clear + setMessages([])）
2. 暴露 `newSession()`（新 sessionId + history.clear + setMessages([])）

**验证：** tsc

## T5: App/Input 集成

**文件：** `src/tui/App.tsx`、`src/tui/Input.tsx`
**依赖：** T3、T4
**步骤：**
1. App：创建 registry + dispatcher（cli 传入或 App 内构造）；handleSend 改 dispatch 优先；UiController 实现（showMessage→compactMsg、sendUserMessage→stream.send、setMode→setUserMode、clearHistory→stream.clearHistory、compact→stream.compact、sessionAction→list/resume/new、memoryList→读 memory 目录、permissionSummary→模式+规则路径、getStatus→格式化）
2. Input：useInput 捕获 tab → props.onTabComplete(value) → 单匹配补全 setValue / 多匹配 App 显示菜单（方向键选择、Esc 关闭）
3. cli：registry 构造 + register 十命令 + 冲突 catch → 打印 + exit 1

**验证：** tsc；tui_smoke 不崩；/status 等命令真机路径

## T6: 测试全量

**文件：** `test/commands_test.ts`、`test/tui_smoke.tsx`
**依赖：** T0-T5
**步骤：**
1. commands_test 全量（T0-T3 用例汇总）
2. tui_smoke 更新（新 props）
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P9 全部用例）

## T7: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T6
**步骤：**
1. 逐个跑十命令：/help /status /compact /clear /plan /do /session /memory /permission /review
2. Tab 补全：输入 `/s` 按 Tab → 补全 /session；输入 `/m` 按 Tab → 菜单（/memory /mode）
3. 大写测试：/HELP 生效

**验证：** 十命令行为正确、补全工作、大小写不敏感

## 执行顺序

```
T0/T1（并行）→ T2 → T3 → T5（T4 可并行）→ T6 → T7
```

依赖链：T2 需 T0；T3 需 T1+T2；T5 需 T3+T4；T6 需全部；T7 需 T6。
