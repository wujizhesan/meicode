# MewCode Phase2 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/tools/types.ts` | Tool/ToolResult/ToolContext/JsonSchema |
| 新建 | `src/tools/registry.ts` | ToolRegistry |
| 新建 | `src/tools/read_file.ts` | 读文件工具 |
| 新建 | `src/tools/write_file.ts` | 写文件工具 |
| 新建 | `src/tools/edit_file.ts` | 原文唯一匹配替换 |
| 新建 | `src/tools/run_command.ts` | 命令执行（确认+超时） |
| 新建 | `src/tools/find_files.ts` | glob 找文件 |
| 新建 | `src/tools/grep_code.ts` | 正则搜内容 |
| 新建 | `src/tools/index.ts` | createTools(ctx) 工厂 |
| 修改 | `src/provider/types.ts` | StreamEvent.tool_call、ChatMessage 扩展、Provider.tools |
| 修改 | `src/provider/openai.ts` | tools 请求 + tool_calls 分片聚合 + 消息转换 |
| 修改 | `src/tui/useStream.ts` | 单轮工具循环 |
| 修改 | `src/tui/App.tsx` | 确认弹窗 |
| 修改 | `test/smoke.ts` | 全部新增测试 |
| 修改 | `test/tui_smoke.tsx` | 确认弹窗渲染（TTY） |

## T0: 工具类型与注册中心

**文件：** `src/tools/types.ts`、`src/tools/registry.ts`、`src/provider/types.ts`
**依赖：** 无
**步骤：**
1. types.ts：JsonSchema（type/properties/required/description 最小结构）、Tool、ToolResult、ToolContext
2. registry.ts：register（重名抛错）/get/toOpenAITools/list
3. provider/types.ts：ChatMessage 加 `tool_calls?`/`tool_call_id?` 与 `role: 'tool'`；StreamEvent 加 `tool_call`；Provider.streamChat 的 opts 加 `tools?`

**验证：** tsc 通过；registry 测试：登记 2 个假工具 → get 命中/未命中 → toOpenAITools 输出 OpenAI 格式 → 重名抛错

## T1: read_file + write_file

**文件：** `src/tools/read_file.ts`、`src/tools/write_file.ts`
**依赖：** T0
**步骤：**
1. read_file：参数 `{path}`；`fs.promises.readFile(join(ctx.cwd, path), 'utf8')`；>8KB 截断 + truncated；try/catch 转结构化错误
2. write_file：参数 `{path, content}`；mkdir recursive 父目录；写入后返回字节数
3. 路径处理：ctx.cwd 相对 + path.isAbsolute 支持绝对路径

**验证：** 直调测试：写临时文件 → 读回内容一致；读不存在文件 → `success:false` + 明确错误；>8KB 文件截断标记

## T2: edit_file

**文件：** `src/tools/edit_file.ts`
**依赖：** T0
**步骤：**
1. 参数 `{path, old_text, new_text}`
2. 读文件 → `content.split(old_text)`：
   - 0 处 → `{success:false, error:'未找到原文片段（检查转义与换行）'}`
   - ≥2 处 → `{success:false, error:'原文匹配到 N 处（首个位置在第 X 字符），请提供更长上下文'}`
   - 恰 1 处 → 拼接替换，写回，返回变更前后片段对比
3. 文件不存在/读失败 → 结构化错误

**验证：** 直调测试：唯一匹配成功替换；零匹配报错信息含「未找到」；构造两处相同文本 → 报「匹配到 2 处」

## T3: run_command

**文件：** `src/tools/run_command.ts`
**依赖：** T0
**步骤：**
1. 参数 `{command, args?, timeout?}`
2. 执行前 `ctx.confirm`：不存在 confirm 或返回 false → `{success:false, error:'用户拒绝执行命令'}`
3. `spawn(command, args ?? [], { cwd: ctx.cwd, shell: process.platform === 'win32' })`；stdout+stderr 合并截断 8KB
4. 超时（默认 30s，参数可覆盖）：kill + `{success:false, error:'命令超时（Ns）'}`
5. 非零退出码 → `{success:false, error: '命令退出码 N' + 输出尾部}`
6. spawn 错误（命令不存在）→ 结构化错误

**验证：** 直调测试：confirm 拒绝 → 不执行（副作用检查）；confirm 接受 + `echo hello` → success + 输出含 hello；`node -e "setTimeout(()=>{}, 5000)"` 配 timeout 500ms → 超时错误；`nonexistent_cmd_xyz` → 结构化错误

## T4: find_files + grep_code

**文件：** `src/tools/find_files.ts`、`src/tools/grep_code.ts`
**依赖：** T0
**步骤：**
1. find_files：参数 `{pattern, path?}`；优先 `fs.promises.glob`（Node 24 内置，task 里先 `node -e "fs.promises.glob"` 验证可用，不可用 `npm i fast-glob`）；排除 node_modules/.git；相对路径输出，上限 100 条 + 截断标注
2. grep_code：参数 `{pattern, path?}`；递归目录收集文件（排除 node_modules/.git）→ 逐行正则匹配 → `文件:行号: 行内容`；上限 200 条；非法正则 → 结构化错误

**验证：** 直调测试：临时目录放 3 个文件（含嵌套）→ glob `**/*.ts` 找到预期文件；grep `import` 返回含文件:行号:格式；非法正则 `[` → 结构化错误

## T5: createTools 工厂与直调测试

**文件：** `src/tools/index.ts`、`test/smoke.ts`
**依赖：** T1-T4
**步骤：**
1. index.ts：`createTools(ctx): Tool[]` 返回六工具数组
2. smoke.ts 增加：六工具登记 → toOpenAITools 六项齐全（name/description/parameters 字段）；六工具各自直调冒烟

**验证：** smoke 全绿；toOpenAITools 输出 `[{type:'function', function:{name,description,parameters}}]`

## T6: openai.ts 工具调用改造

**文件：** `src/provider/openai.ts`
**依赖：** T0
**步骤：**
1. 请求体：opts.tools 存在时加 `tools: opts.tools`（原样传）
2. 流式解析：新增 tool_calls 聚合——`delta.tool_calls` 数组按 `index` 归组到 Map；`function.name`/`id` 首帧捕获；`function.arguments` 字符串拼接；流结束（[DONE] 或 message_stop）后对未发出的分片 JSON.parse → 成功 yield `tool_call`，失败 yield `error('工具参数解析失败: ...')`
3. 消息转换 `toOpenAIMessages`：assistant 带 tool_calls → `{role:'assistant', content: null, tool_calls: [{id, type:'function', function:{name, arguments(字符串)}}]}`；`role:'tool'` → `{role:'tool', tool_call_id, content}`；其余不变
4. 注意：带 tool_calls 的 assistant 消息 content 必须为 null（不能拼接）

**验证：** fake SSE 分片测试：三帧 `tool_calls` delta（index 0：id+name+arguments 碎片 ×2）→ 聚合出完整 tool_call 事件（arguments JSON 解析正确）；带 tool_calls 的历史消息发送 → 请求 body 里 assistant content 为 null、tool_calls 完整、tool 消息带 tool_call_id

## T7: useStream 单轮工具循环

**文件：** `src/tui/useStream.ts`
**依赖：** T5、T6
**步骤：**
1. send 重构为循环（见 plan 模块设计伪码）：第一轮收集 tool_call → 无则最终回复收尾
2. 有 tool_call（第 1 轮）：push assistant 消息（含 tool_calls 元数据、content 空）→ 逐个执行（registry.get 未命中 → 构造「未找到工具」结果）→ push tool 消息 → 第二轮 streamChat
3. 第二轮再出 tool_call → 截断：不执行，提示「本阶段暂不支持连环调用」，保留已渲染文本，收尾
4. registry 与 ctx.confirm 由 App 注入（useStream 参数扩展）

**验证：** 端到端 fake 测试（smoke 内）：fake provider 第一轮出 tool_call（read_file）→ 第二轮出 text → 断言 history 含 user/assistant(tool_calls)/tool/assistant 四段、tool 消息内容为文件内容；fake provider 两轮都出 tool_call → 断言截断提示

## T8: App 确认弹窗

**文件：** `src/tui/App.tsx`
**依赖：** T3
**步骤：**
1. 状态 `pendingConfirm: {command, resolve} | null`
2. pendingConfirm 非空时：渲染「⚠ 执行命令: <command>（Enter 执行 / Esc 拒绝）」，Input 禁用
3. useInput：Enter → resolve(true)、清空；Esc → resolve(false)、清空
4. ctx.confirm 注入 useStream（`(cmd) => new Promise(res => setPendingConfirm({command: cmd, resolve: res}))`）

**验证：** tsc 通过；tui_smoke.tsx 在 TTY 下渲染确认行（非 TTY 跳过）；手动路径留 checklist

## T9: 全链路集成验证

**文件：** 全项目
**依赖：** T0-T8
**步骤：**
1. `npx tsc --noEmit` 全绿
2. `npm test` 全绿（smoke 含 Phase1 回归 + Phase2 新增）
3. 冒烟：cli 启动不崩（非 TTY 提示路径）；`--config nonexist` 错误路径不变

**验证：** tsc exit 0；npm test 0 failed（Phase1 用例不得回归）

## 执行顺序

```
T0 ─→ T1/T2/T3/T4（并行）─→ T5 ─→ T6 ─→ T7 ─→ T9
                          T3 ─→ T8（可与 T7 并行）──┘
```

依赖链：T7 需 T5+T6；T8 需 T3；T9 需全部。
