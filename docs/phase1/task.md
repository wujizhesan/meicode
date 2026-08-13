# MewCode Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `package.json` | ESM 项目定义 + 依赖 |
| 新建 | `tsconfig.json` | erasable-only 语法约束 |
| 新建 | `config.example.yaml` | 六字段示例配置 |
| 新建 | `src/config/types.ts` | ProviderConfig 定义 |
| 新建 | `src/config/loader.ts` | YAML 加载与校验 |
| 新建 | `src/provider/types.ts` | ChatMessage/StreamEvent/Provider |
| 新建 | `src/provider/index.ts` | createProvider 工厂 |
| 新建 | `src/provider/anthropic.ts` | Claude 实现 |
| 新建 | `src/provider/openai.ts` | OpenAI 实现 |
| 新建 | `src/session/history.ts` | 历史容器 |
| 新建 | `src/tui/App.tsx` | 根组件 + 状态机 |
| 新建 | `src/tui/ChatView.tsx` | 消息列表渲染 |
| 新建 | `src/tui/Input.tsx` | 输入框 |
| 新建 | `src/tui/useStream.ts` | 流消费 hook |
| 新建 | `src/cli.ts` | 入口 main() |
| 新建 | `test/sse_samples.ts` | 双后端 SSE 真实格式样例（协议样本） |

## T0: 项目脚手架

**文件：** `package.json`、`tsconfig.json`
**依赖：** 无
**步骤：**
1. `mkdir D:\MewCode` 已建；初始化 `package.json`（`"type": "module"`，name: mewcode）
2. 安装依赖：`npm i ink ink-text-input react yaml eventsource-parser` + `npm i -D typescript @types/react @types/node`
3. tsconfig.json：`"erasableSyntaxOnly": true`、`"module": "nodenext"`、`"noEmit": true`、`"allowImportingTsExtensions": true`、strict
4. 创建 `config.example.yaml`（六字段占位示例）

**验证：** `npm install` 无错误；`npx tsc --noEmit` 对空项目通过

## T1: config 层

**文件：** `src/config/types.ts`、`src/config/loader.ts`
**依赖：** T0
**步骤：**
1. types.ts：定义 ProviderConfig（name/protocol/model/base_url/api_key/thinking?）
2. loader.ts：`loadConfig(path?)`——默认 `~/.mewcode/config.yaml`（os.homedir()），`yaml` 包解析
3. 校验：缺 name/protocol/model/base_url/api_key 抛「字段 X 缺失」；protocol 非 anthropic/openai 抛「不支持的 protocol」；api_key 空抛错
4. 导出 `loadConfig` 与类型

**验证：** `node --experimental-strip-types`（Node 24 直接 `node src/config/loader.ts` 不行——loader 无入口，改用一次性脚本）：
```bash
node -e "import('./src/config/loader.ts').then(async m => { try { await m.loadConfig('nonexist.yaml') } catch(e) { console.log(e.message) } })"
```
期望输出「配置文件不存在」类错误；再对合法/非法样例各跑一次

## T2: provider 接口与工厂

**文件：** `src/provider/types.ts`、`src/provider/index.ts`
**依赖：** T1（ProviderConfig 类型）
**步骤：**
1. types.ts：ChatMessage、StreamEvent（text/thinking/done/error 联合）、Provider 接口（`streamChat(messages, opts): AsyncGenerator<StreamEvent>`）
2. index.ts：`createProvider(cfg)`——anthropic→AnthropicProvider、openai→OpenAIProvider、其他抛错
3. 两实现先放桩（throw "not implemented"），保证工厂可测

**验证：** 工厂对合法 config 返回对应实例；非法 protocol 抛「不支持的 protocol: xxx」

## T3: Anthropic 实现

**文件：** `src/provider/anthropic.ts`
**依赖：** T2
**步骤：**
1. `streamChat`：POST `{base_url}/v1/messages`，头 `x-api-key`、`anthropic-version: 2023-06-01`、`content-type: application/json`
2. body：model、max_tokens（thinking 开时 32000，关时 4096）、stream:true、messages 转换（ChatMessage → {role, content}，末尾 user 消息转 user turn 规则按 Anthropic 规范：首轮 user 补 `system: "You are MewCode."` 提示文本）
3. thinking 开：body 加 `thinking: {type: "enabled", budget_tokens: 16000}`
4. 用 `eventsource-parser`（createParser）解析 `response.body`；事件归一化：`content_block_delta` 的 `text_delta`→text、`thinking_delta`→thinking、`message_stop`→done
5. 网络错误 → yield `{type:'error', message}`；HTTP 非 2xx → 读 error body 报出

**验证：** `test/sse_samples.ts` 内含 Anthropic 真实格式 SSE 样例（message_start/content_block_start/thinking_delta/text_delta/message_stop 按官方文档字段构造）；用本地 fake server（node http 一次性脚本）返回该样例，`streamChat` 输出的 StreamEvent 序列与预期一致（text 增量逐字可拼回完整句子、thinking 增量单独成流）

## T4: OpenAI 实现

**文件：** `src/provider/openai.ts`
**依赖：** T2
**步骤：**
1. `streamChat`：POST `{base_url}/v1/chat/completions`，头 `Authorization: Bearer {key}`
2. body：model、messages（直转）、`stream: true`
3. 解析：SSE `data:` 行的 `choices[0].delta.content` → text；`[DONE]` → done
4. 错误处理同 T3

**验证：** 同样用 fake server + 真实 OpenAI SSE 样例（`{"choices":[{"delta":{"content":"..."}}]}` 序列 + `data: [DONE]`），StreamEvent 序列正确

## T5: session 历史容器

**文件：** `src/session/history.ts`
**依赖：** T2（ChatMessage 类型）
**步骤：**
1. class History：私有数组；`push(msg)` 追加；`all()` 返回副本；`clear()` 清空
2. 无截断、无持久化

**验证：** `node -e` 脚本：push 3 条 → all() 长度 3 且顺序正确 → clear() 后空

## T6: TUI 组件

**文件：** `src/tui/App.tsx`、`ChatView.tsx`、`Input.tsx`、`useStream.ts`
**依赖：** T2（类型）、T5
**步骤：**
1. App.tsx：props 注入 Provider 实例 + History；状态机 idle/streaming/error；渲染 ChatView + Input
2. useStream.ts：hook 接收 messages 数组和 onSend 回调——消费 `provider.streamChat` 的 AsyncGenerator，逐事件更新（text 追加正文、thinking 追加暗色区、error 置错误态、done 收尾并 push assistant 到 history）
3. ChatView.tsx：消息列表——user 右侧/正常色，assistant 正文；assistant 含 thinking 时先渲染暗色「思考中…」区（逐字追加），再渲染正文区；滚动到最新（Ink 自动）
4. Input.tsx：`ink-text-input`，placeholder「输入消息（Enter 发送，Ctrl+C 退出）」，streaming 时 disabled
5. 首条消息渲染默认空历史提示「MewCode 就绪——输入问题开始对话」

**验证：** `node src/cli.ts`（T7 之前用临时入口）启动不崩，界面渲染出输入框与就绪提示

## T7: cli 入口集成

**文件：** `src/cli.ts`
**依赖：** T1、T3、T4、T6
**步骤：**
1. 解析 `--config <path>` 参数（手写最小解析，Node 内置无依赖）
2. 调 `loadConfig` → 失败打印错误信息并 exit 1
3. `createProvider` → 渲染 `<App provider history />`（`ink` 的 `render()`）
4. 挂 SIGINT：Ink 默认处理退出；流中断时 useStream 捕获 error 正常收尾

**验证：** 冒烟：`node src/cli.ts --config config.example.yaml` 启动出现界面；`--config nonexist.yaml` 打印清晰错误并 exit 1

## 执行顺序

```
T0 → T1 → T2 ─→ T3 ─┐
                └→ T4 ─→ T7（T6 可与 T3/T4 并行）
      T2 ─→ T5 ─→ T6 ─┘
```

依赖链：T7 需要 T3/T4/T6 全部完成；T6 与 T3/T4 相互独立可并行。
