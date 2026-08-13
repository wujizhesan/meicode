# MewCode Phase10 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/skill/types.ts` | SkillDef/ActiveSkill |
| 新建 | `src/skill/loader.ts` | 三级扫描/frontmatter/目录型/坏文件跳过 |
| 新建 | `src/skill/manager.ts` | SkillManager（激活/索引/白名单/清除） |
| 新建 | `src/skill/index.ts` | createLoadSkillTool + runIsolated |
| 新建 | `src/skills/{commit,review,test}.md` | 三内置样板 |
| 修改 | `src/agent/loop.ts` | toolsOverride 支持 |
| 修改 | `src/tui/useStream.ts` | 激活注入 + isolated + /clear 清理 |
| 修改 | `src/commands/builtin.ts` | /review 移除 |
| 修改 | `src/cli.tsx` | SkillManager 初始化 |
| 新建 | `test/skill_test.ts` | 全量测试 |

## T0: 类型与加载器

**文件：** `src/skill/types.ts`、`src/skill/loader.ts`
**依赖：** 无
**步骤：**
1. types.ts：SkillDef（name/description/tools/mode/history/model/content/source）、ActiveSkill（def+params）
2. loader.ts：
   - 扫描三个目录：文件型 `*.md` + 目录型 `<name>/SKILL.md`
   - frontmatter `---` 提取 → yaml parse → 校验（name/description 必需，mode 缺省 shared）
   - 目录型：`tools/*.json`（schema）→ 转 Tool 定义（实现脚本 `scripts/*.js` 动态 import 导出 execute——第一版仅 schema 注册，脚本实现留 TODO 说明？——不：目录型实现脚本动态 import，execute 调脚本）
   - 坏文件（parse 失败/缺 name）→ skipped 列表 + console.warn
   - 返回 `{ skills: SkillDef[], skipped: string[] }`

**验证：** skill_test：文件型解析（frontmatter 字段/正文/{{param}} 原样保留）；坏 frontmatter 跳过；目录型 SKILL.md 识别；三级列表合并

## T1: SkillManager

**文件：** `src/skill/manager.ts`
**依赖：** T0
**步骤：**
1. loadAll(dirs)：三级加载（内置 → 用户 → 项目，后加载覆盖同名）；白名单校验（tools 中未知工具 → 警告 + 标记不可用）
2. index()：`## 可用 Skills\n- name: description` 列表
3. activate(name, params?)：set active；调 onActivate 回调（注册斜杠命令）；不可用/不存在返回错误文本
4. activePrompt()：`## 已激活 Skill: <name>\n\n<content>`（{{param}} 替换）多激活按顺序拼接
5. activeToolNames()：激活白名单并集（无激活 → null）
6. clear() / deactivate(name)

**验证：** skill_test：loadAll 覆盖（同名项目盖内置）；index 格式；activate 后 activePrompt 含完整指令与参数替换；多激活拼接；白名单并集；clear 清空

## T2: 三内置样板

**文件：** `src/skills/{commit,review,test}.md`
**依赖：** T0
**步骤：**
1. commit.md：tools [run_command, read_file, edit_file]、shared；SOP：git status → diff --stat → 提交信息（{{message}} 可选）→ add+commit → 报告
2. review.md：tools [run_command, read_file]、shared；SOP 复用 /review 改进版提示词（Windows 约束/最多 4 命令/失败止损）
3. test.md：tools [run_command, read_file]、isolated、history 5；SOP：npm test → 分析失败 → 输出结论

**验证：** 文件存在且可被 loader 解析（skill_test 加载三样板断言 name/mode/tools）

## T3: load_skill 工具与 loop toolsOverride

**文件：** `src/skill/index.ts`、`src/agent/loop.ts`
**依赖：** T1、T2
**步骤：**
1. loop.ts：opts 加 `toolsOverride?`——`const tools = opts.toolsOverride ?? (mode === 'plan' ? 只读 : 全部)`
2. skill/index.ts：
   - `createLoadSkillTool(manager, ctx)`：系统级工具 `load_skill`（name 参数）→ manager.activate → 返回激活结果；mode=isolated → 由 useStream 处理（工具返回标记）
   - `runIsolated(skill, mainHistory, opts)`：独立 History（带主历史尾部 history 条数）→ runAgent（maxIterations 8，白名单 tools）→ 收集输出 → LLM 摘要 → 返回摘要文本

**验证：** loop_test：toolsOverride 生效（fake 捕获 tools 断言）；skill_test：load_skill 激活返回正确；runIsolated fake 跑通（摘要文本）

## T4: useStream 集成

**文件：** `src/tui/useStream.ts`
**依赖：** T3
**步骤：**
1. 接收 skillManager
2. send 前：activePrompt() 作为独立 system 消息（插在轮次指令 system 之后）；toolsOverride = activeToolNames 并集 + 系统工具 + load_skill
3. load_skill 触发 isolated：send 里检测（load_skill 工具调用返回 isolated 标记）→ runIsolated → 摘要 push 主历史（role: system「[Skill xxx 结果] 摘要」）
4. clearHistory 里调 skillManager.clear()

**验证：** tsc；skill_test 无法测 React——核心逻辑（注入拼接/白名单计算）抽纯函数测试

## T5: 命令系统衔接

**文件：** `src/commands/builtin.ts`、`src/cli.tsx`
**依赖：** T1
**步骤：**
1. builtin.ts：移除 /review 命令（review skill 取代）
2. cli.tsx：创建 SkillManager（dirs：内置 src/skills、用户 ~/.mewcode/skills、项目 <cwd>/skills）→ loadAll → 传给 App；Skill 激活回调注册斜杠命令（`/<skill名>` → sendUserMessage 触发）

**验证：** tsc；commands_test 更新（/review 移除断言）

## T6: 测试全量

**文件：** `test/skill_test.ts`、`test/commands_test.ts`
**依赖：** T0-T5
**步骤：**
1. skill_test 全量（T0-T3 用例）
2. commands_test：/review 移除后未知命令
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P10 全部用例）

## T7: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T6
**步骤：**
1. 启动：可见「可用 Skills」索引（commit/review/test）
2. `/commit`（激活+执行）→ 模型按 SOP 提交变更
3. `/test`（isolated）→ 独立跑 npm test → 摘要回流
4. `/clear` → 激活 Skill 清除
5. 自建 skill 到项目 skills/ → 重启出现 → 加载可用

**验证：** 两阶段/两模式/白名单/斜杠全链路

## 执行顺序

```
T0 → T1 → T2（可并行）→ T3 → T4/T5 → T6 → T7
```

依赖链：T1 需 T0；T3 需 T1+T2；T4 需 T3；T5 需 T1；T6 需全部；T7 需 T6。
