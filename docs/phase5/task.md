# MewCode Phase5 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/permission/types.ts` | PermissionMode/Rule/Decision/AskResult |
| 新建 | `src/permission/blacklist.ts` | 危险命令正则（硬编码） |
| 新建 | `src/permission/sandbox.ts` | 路径沙箱（realpath 防逃逸） |
| 新建 | `src/permission/rules.ts` | RuleEngine（三层加载/匹配） |
| 新建 | `src/permission/store.ts` | 会话规则 + 永久写入 |
| 新建 | `src/permission/index.ts` | checkPermission 裁决链 |
| 修改 | `src/tools/types.ts` | ToolContext 加 permission/ask |
| 修改 | `src/agent/loop.ts` | executeOne 前裁决 |
| 修改 | `src/tui/App.tsx` | 四态弹窗 + /mode |
| 修改 | `src/tui/useStream.ts` | mode + permission 上下文 |
| 修改 | `src/cli.tsx` | RuleEngine 初始化 |
| 新建 | `test/permission_test.ts` | 权限全量测试 |
| 新建 | `.mewcode/rules.yaml` 示例 | 项目级规则示例（docs 说明） |

## T0: 类型与黑名单

**文件：** `src/permission/types.ts`、`src/permission/blacklist.ts`
**依赖：** 无
**步骤：**
1. types.ts：PermissionMode / Rule / Decision / AskResult / RuleSource / ToolCallInfo
2. blacklist.ts：DANGEROUS_PATTERNS 正则数组（rm 根目录、del/erase/rd /s、format、diskpart、reg delete、chkdsk /f? 不——保守起见：rm -rf /、del /s、rd /s、format、diskpart、diskpart 类、`> nul` 重定向危险不在此层）+ `match(command)` 返回 {matched, desc}
3. 黑名单匹配完整命令串（trim 后）

**验证：** permission_test 初步：`rm -rf /`、`del /s /q C:\`、`format c:` 命中；`git status`、`node -v` 不命中

## T1: 路径沙箱

**文件：** `src/permission/sandbox.ts`
**依赖：** T0
**步骤：**
1. `resolveReal(target)`：realpath；ENOENT 时对最深已存在祖先 realpath 再拼接剩余段
2. `isPathAllowed(target, cwd)`：resolveReal 后 `real === cwd || real.startsWith(cwd + sep)`
3. 相对路径先 join(cwd) 再解析

**验证：** 测试：cwd 内文件允许；cwd 外绝对路径拒绝；**符号链接逃逸**：cwd 内建 link 指向外部文件 → 拒绝；不存在的深层路径（cwd 内）允许

## T2: 规则引擎

**文件：** `src/permission/rules.ts`、`src/permission/store.ts`
**依赖：** T0
**步骤：**
1. `npm i minimatch`
2. RuleEngine：`loadAll(userFile, projectFile, localFile)`（缺文件静默、YAML 解析失败警告跳过）、`addSessionRule`、`match(call)`（session→local→project→user 顺序；同层同工具 deny 优先）、`appendProjectRule(rule)`（读-追加-写项目级文件，不存在则创建）
3. 模式匹配：工具名精确；参数 minimatch（`git *`、`src/**`）；规则文件格式 `tool/pattern/action`

**验证：** 测试：三层加载；`run_command(git *)` allow 匹配 `git status`；deny 优先；会话级盖过项目级；appendProjectRule 写文件后 reload 生效；坏 YAML 警告跳过

## T3: 裁决链

**文件：** `src/permission/index.ts`
**依赖：** T1、T2
**步骤：**
1. `checkPermission(call, { cwd, mode, engine })` 五层：
   - ① run_command → blacklist.match → deny
   - ② 文件工具 → sandbox：允许→继续；越界→engine.match（allow 放行/deny 拒/未命中→按模式）
   - ③ engine.match → 命中裁决
   - ④ 未命中 → strict deny / permissive allow / default ask
2. 模式解析：显式 mode ?? 用户级 YAML mode ?? 'default'

**验证：** 测试：黑名单优先；沙箱越界 + 规则 allow 放开；strict 白名单（未 allow 即拒）；permissive 放行（黑名单仍拦）；default 未命中 → ask

## T4: agent 集成

**文件：** `src/tools/types.ts`、`src/agent/loop.ts`
**依赖：** T3
**步骤：**
1. tools/types.ts：ToolContext 加 `permission?: { mode; engine }` 与 `ask?: (call: ToolCallInfo) => Promise<AskResult>`
2. loop.ts executeOne 前：ctx.permission 存在时 checkPermission：
   - deny → 返回 `{ success:false, error:'[权限拒绝] reason' }`
   - ask → ctx.ask 调用：once 放行 / session 加规则 / forever 写项目级 / deny 拒绝（error '[权限拒绝] 用户拒绝'）
   - allow → 继续
3. 拒绝结果走既有 tool 消息回灌路径（循环自然继续）

**验证：** loop_test 加：fake permission deny → tool 结果含 `[权限拒绝]` 且循环继续（最终 complete）；fake ask 返回 once/session/deny 各态

## T5: TUI 四态弹窗 + /mode

**文件：** `src/tui/App.tsx`、`src/tui/useStream.ts`、`src/cli.tsx`
**依赖：** T4
**步骤：**
1. useStream：mode 状态（'default'，初始化时可读用户级 YAML）+ permission 上下文注入 runAgent
2. App：pendingAsk 四态弹窗「⚠ 权限请求: <工具> <参数摘要>（Enter 本次 / S 会话 / P 永久 / Esc 拒绝）」；useInput 扩展 s/p 键；`/mode strict|default|permissive` 命令切换
3. cli.tsx：RuleEngine 初始化（三层路径：`~/.mewcode/rules.yaml`、`<cwd>/.mewcode/rules.yaml`、`<cwd>/.mewcode/rules.local.yaml`）

**验证：** tsc；tui_smoke 快照不崩；/mode 切换状态正确

## T6: 测试与回归

**文件：** `test/permission_test.ts`、`test/loop_test.ts`
**依赖：** T0-T5
**步骤：**
1. permission_test.ts 全量：黑名单/沙箱逃逸/规则三层/优先级/模式三态/人在回路四态/永久写入
2. loop_test 权限集成用例（T4 已加）
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P5 全部用例）

## T7: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T6
**步骤：**
1. 真机：问「执行 del /s /q C:\Windows\temp\*」→ 黑名单拒绝，模型收到 [权限拒绝] 后调整
2. `/mode strict` → 未 allow 的工具调用被拒；`/mode permissive` → 放行
3. default 模式触发弹窗：测试四态（本次/会话/永久/Esc）
4. 检查项目级 rules.yaml 被永久放行写入

**验证：** 五层各自可触发且循环不终止

## 执行顺序

```
T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7
```

依赖链：T3 需 T1+T2；T4 需 T3；T5 需 T4；T6 需全部；T7 需 T6。
