# MewCode Phase6 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/mcp/config.ts` | 配置解析/两层合并/${VAR} |
| 新建 | `src/mcp/manager.ts` | McpClientManager（懒发现+缓存+closeAll） |
| 新建 | `src/mcp/adapter.ts` | 远端工具 → MewCode Tool |
| 新建 | `src/mcp/index.ts` | registerMcpTools 入口 |
| 修改 | `src/config/types.ts` | 加 mcpServers 字段 |
| 修改 | `src/config/loader.ts` | mcpServers 解析接入 |
| 修改 | `src/cli.tsx` | manager 创建 + 注册接入 + 退出清理 |
| 修改 | `src/tui/useStream.ts` | 首次 send 前发现 |
| 新建 | `test/fixtures/mcp_server.ts` | 最小 stdio MCP Server（echo） |
| 新建 | `test/fixtures/mcp_http_server.ts` | 最小 Streamable HTTP Server |
| 新建 | `test/mcp_test.ts` | 全量测试 |

## T0: 依赖与最小 Server fixture

**文件：** `test/fixtures/mcp_server.ts`、`test/fixtures/mcp_http_server.ts`
**依赖：** 无
**步骤：**
1. `npm i @modelcontextprotocol/sdk`
2. mcp_server.ts：SDK Server 类 + StdioServerTransport；注册一个 `echo` 工具（inputSchema: {text: string}），callTool 返回 `echo: <text>`；capabilities.tools
3. mcp_http_server.ts：SDK Server + StreamableHTTPServerTransport 包在 node:http server 里（参考 SDK 官方示例）；同样 echo 工具；端口 0（随机）打印端口后保持运行

**验证：** 手动冒烟：`node --import tsx test/fixtures/mcp_server.ts` 能启动等输入（管道连接由测试驱动）

## T1: 配置解析

**文件：** `src/mcp/config.ts`、`src/config/types.ts`、`src/config/loader.ts`
**依赖：** T0
**步骤：**
1. config/types.ts：ProviderConfig 加可选 `mcpServers?: Record<string, unknown>`
2. mcp/config.ts：`parseMcpServers(rawUser, rawProject): McpServerConfig[]`——两层合并（项目盖用户、同 name 覆盖）、`expandEnv`（${VAR} → process.env，缺失保留）、校验（缺 type/command/url 跳过+提示）
3. loader.ts：解析 mcpServers 段（两层文件分别取），坏条目不阻塞主配置

**验证：** smoke/mcp_test：两层合并（项目覆盖）、${VAR} 展开（设 env 测试）、缺失保留、坏条目跳过

## T2: 连接管理

**文件：** `src/mcp/manager.ts`
**依赖：** T0、T1
**步骤：**
1. `discoverAll()`：并行（Promise.all）逐 Server：spawn/连接 → initialize（SDK Client.connect 自动）→ listTools → 缓存（clients + toolCache）；单 Server 失败 catch 进 failed 列表，不影响其他
2. `callTool(serverName, toolName, args)`：未连接 → 重新连接该 Server；MCP result 转换：content 数组提取文本拼接、isError → error；异常 → `[MCP 错误] ...`
3. `closeAll()`：逐个 client.close()
4. 重复 discoverAll 命中缓存（不重连）

**验证：** mcp_test：连 fixture server → discoverAll ok 列表含 server 名；callTool echo 返回正确；坏 Server（command 不存在）→ failed 列表含它、好 Server 正常；重复 discover 不重连（计数）

## T3: 工具适配与注册

**文件：** `src/mcp/adapter.ts`、`src/mcp/index.ts`
**依赖：** T2
**步骤：**
1. adapter：`toMewTool(serverName, info, manager)`——name 前缀、description 透传（空给默认）、inputSchema → MewCode JsonSchema（宽容：保留 type/properties/required，多余字段忽略）、execute 调 callTool
2. index：`registerMcpTools(registry, manager)`——discoverAll → 逐 Server 工具注册（重名 try/catch 跳过）

**验证：** mcp_test：注册后 registry.get('testserver_echo') 存在、parameters 正确；Agent 视角（toOpenAITools 包含远端工具）

## T4: cli/useStream 接入

**文件：** `src/cli.tsx`、`src/tui/useStream.ts`
**依赖：** T3
**步骤：**
1. cli：loadConfig 后创建 McpClientManager（servers 从配置来）；传给 App；进程退出钩子（SIGINT 正常退出路径 + process exit）→ closeAll
2. useStream：`discoveredRef` 标志——首次 send 前 `await registerMcpTools`（并行发现，失败 Server 提示但不阻塞），完成后正常发请求

**验证：** tsc；tui_smoke 不崩；headless 冒烟：live 脚本注册 + 调用远端工具

## T5: 测试全量

**文件：** `test/mcp_test.ts`
**依赖：** T1-T4
**步骤：**
1. mcp_test.ts 全量：
   - 配置：两层合并/${VAR}/坏条目
   - stdio 发现：fixture server → ok
   - 注册：前缀名/schema/描述
   - 调用：echo 往返正确
   - 隔离：坏 Server + 好 Server 并行 → 好 Server 正常
   - HTTP：启动 http fixture → 发现+调用
   - 缓存：重复 discover 不重连
2. 回归：npm test 全绿（89 + 新增）

**验证：** tsc 0 错误；npm test 全绿

## T6: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T5
**步骤：**
1. 用户配置里加一个真实 MCP Server（如官方示例 `npx -y @modelcontextprotocol/server-everything` 或自建 fixture 的 stdio 声明）
2. 启动 MewCode → 首次提问后远端工具出现（状态/回复可见）
3. 让模型调用远端工具（如 echo/示例工具）→ 结果回灌

**验证：** 远端工具从发现到调用全链路通

## 执行顺序

```
T0 → T1 → T2 → T3 → T4 → T5 → T6
```

依赖链：T1 需 T0（fixture 供后续）；T2 需 T0+T1；T3 需 T2；T4 需 T3；T5 需全部；T6 需 T5。
