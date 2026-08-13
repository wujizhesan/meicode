# MewCode Phase6 Plan — MCP 客户端

## 架构概览

新增 `mcp/` 层：配置解析 → 连接管理（懒发现 + 缓存）→ 工具适配 → 注册进既有 registry。Agent 侧完全无感（远端工具与内置工具同走 Tool 接口 + 权限裁决）。

```
cli 启动
  → loadConfig（含 mcpServers，两层合并 + ${VAR} 展开）
  → McpClientManager（懒：不连接）
  → 首次 send（Agent 首次请求）前:
      manager.discoverAll()（并行连接各 Server → initialize → tools/list，失败跳过）
      → adapter 转 MewCode Tool → registry.register（serverName_toolName）
  → Agent 正常循环：模型看到远端工具 → 调用 → execute → manager.callTool → tools/call → ToolResult
  → 退出: manager.closeAll()（kill 子进程）
```

依赖方向：mcp → config 类型 / tools 类型 / registry；cli → mcp。无环。

## 核心数据结构

### 配置（config.yaml 扩展）
```yaml
mcpServers:
  github:
    type: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
  remote:
    type: http
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer ${TOKEN}"
```

### 类型
```ts
type McpServerConfig =
  | { name: string; type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: 'http'; url: string; headers?: Record<string, string> }

interface RemoteToolInfo {
  name: string          // 远端原名（不含前缀）
  description: string
  inputSchema: Record<string, unknown>   // MCP JSON Schema
}
```

## 模块设计

### mcp/config.ts
```ts
parseMcpServers(userCfg, projectCfg): McpServerConfig[]
// 两层合并（项目盖用户，同 name 覆盖）；缺 type/command/url 报错跳过该 Server
expandEnv(value): string  // ${VAR} → process.env[VAR]，缺失保留原样
```

### mcp/manager.ts（McpClientManager）
```ts
class McpClientManager {
  private clients = new Map<string, Client>()          // 连接缓存
  private toolCache = new Map<string, RemoteToolInfo[]>()  // 工具发现缓存

  constructor(private servers: McpServerConfig[])

  async discoverAll(): Promise<{ ok: string[]; failed: { name: string; error: string }[] }>
  // 并行 connect+initialize+listTools；单 Server 失败 catch 记录，不影响其他
  // 同一 Server 重复调用命中缓存

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult>
  // 未连接 → 该 Server 重新尝试连接；MCP result → ToolResult（文本 content 提取，isError → error）
  // 失败 → { success: false, error: '[MCP 错误] ...' }

  async closeAll(): Promise<void>
  // 逐个 client.close()（SDK 关闭传输 → kill 子进程）
}
```

### mcp/adapter.ts
```ts
function toMewTool(serverName: string, info: RemoteToolInfo, manager: McpClientManager): Tool
// name = `${serverName}_${info.name}`
// description 透传（远端空则给默认）
// parameters: inputSchema → MewCode JsonSchema（透传 properties/required，宽容转换）
// execute: manager.callTool(serverName, info.name, args)
```

### mcp/index.ts
```ts
async function registerMcpTools(registry: ToolRegistry, manager: McpClientManager): Promise<{ ok: string[]; failed: string[] }>
// discoverAll → 每 Server 工具 toMewTool → registry.register（重名：前缀后一般不会，仍 try/catch 跳过）
```

### config/loader.ts（扩展）
- loadConfig 返回结构加 `mcpServers`（顶层可选字段，解析用 mcp/config.ts）
- mcpServers 字段校验宽松：坏条目跳过并提示，不阻塞主配置

### cli.tsx（接入）
- 启动：loadConfig（含 mcpServers）→ 创建 McpClientManager
- useStream 首次 send 前：await registerMcpTools（并行发现，失败 Server 跳过提示，不阻塞对话）
- 退出：process exit 钩子 → manager.closeAll()

### useStream.ts（小改）
- send 增加「首次发现远端工具」步骤（标志位，只跑一次）
- registry 已含远端工具 → 请求 tools 列表自动包含（现有 toOpenAITools 路径不变）

## 文件组织

```
D:\MewCode\
├── src/
│   ├── mcp/
│   │   ├── config.ts      — 配置解析/合并/${VAR}
│   │   ├── manager.ts     — McpClientManager（懒发现+缓存+closeAll）
│   │   ├── adapter.ts     — 远端工具 → MewCode Tool
│   │   └── index.ts       — registerMcpTools 入口
│   ├── config/
│   │   ├── types.ts       — 加 mcpServers 字段
│   │   └── loader.ts      — mcpServers 解析接入
│   ├── cli.tsx            — manager 创建 + 注册接入 + 退出清理
│   └── tui/useStream.ts   — 首次 send 前发现
├── test/
│   ├── fixtures/mcp_server.ts       — 最小 stdio MCP Server（echo 工具）
│   ├── fixtures/mcp_http_server.ts  — 最小 Streamable HTTP Server
│   └── mcp_test.ts                 — 配置/发现/注册/调用/隔离/HTTP 全量
└── docs/phase6/            — 四文档
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 协议 | @modelcontextprotocol/sdk（Client + Stdio/StreamableHTTP Transport） | 用户决策；帧格式/SSE/配对全封装 |
| 发现时机 | 首次 send 前并行懒发现（非启动时） | 模型需先见工具列表；进界面零阻塞；失败 Server 跳过 |
| 命名 | `<serverName>_<toolName>` | 用户决策，天然防冲突 |
| 故障隔离 | 逐 Server try/catch，失败记录跳过 | spec F5 |
| ${VAR} | process.env 展开，缺失保留+提示 | spec N2 |
| 退出清理 | client.close()（SDK 关传输 kill 子进程） | spec N3 |
| 工具结果 | MCP content 文本提取 + isError → ToolResult | 统一走结构化错误 |

## spec 覆盖检查

| F 需求 | 架构归属 |
|--------|---------|
| F1 配置加载 | mcp/config.ts + config/loader.ts |
| F2 两种传输 | manager（SDK Transport 选择） |
| F3 会话三步 | SDK Client（initialize/listTools/callTool） |
| F4 工具适配 | mcp/adapter.ts |
| F5 生命周期 | manager（懒发现+缓存+closeAll） |
| F6 错误处理 | manager.callTool → ToolResult |
| N1 启动不阻塞 | 懒发现（首次 send 前） |
| N2 ${VAR} | config.ts expandEnv |
| N3 退出清理 | closeAll |
