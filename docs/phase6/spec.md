# MewCode Phase6 Spec — MCP 客户端

## 背景

MewCode 已有六内置工具 + 权限系统。本阶段实现 MCP 客户端：启动后从配置发现外部 MCP Server，通过标准 MCP 协议把远端工具无缝接入工具中心（registry），Agent 调用时完全无感。协议层用官方 `@modelcontextprotocol/sdk`（Client 类封装 JSON-RPC 2.0、stdio/Streamable HTTP 传输、initialize/tools/list/call 会话）。

## 目标

- 配置文件声明 Server 列表（用户级 + 项目级两层合并）
- 懒连接：首次调用某 Server 工具时握手并发现工具，连接缓存复用
- 远端工具以前缀命名注册进 registry，Agent 无感调用
- 单 Server 故障不影响其他 Server 与内置工具

## 功能需求

- F1: 配置加载 —— config.yaml 加 `mcpServers` 段（map：key=Server 名，value 含 `type`）；stdio 类型填 `command`/`args`/`env`；http 类型填 `url`/`headers`；用户级 `~/.mewcode/config.yaml` 与项目级 `<cwd>/.mewcode/config.yaml` 合并（项目盖用户，Server 名相同则后者覆盖前者）；`env` 与 `headers` 的值支持 `${VAR}` 从 process.env 展开
- F2: 两种传输 —— stdio：spawn 子进程 + `StdioClientTransport`；http：`StreamableHTTPClientTransport`（官方 SDK）
- F3: 会话三步 —— 初始化握手（initialize）→ 工具发现（tools/list）→ 工具调用（tools/call），由 SDK Client 封装
- F4: 工具适配 —— 远端工具包装为 MewCode Tool 接口：`name = <serverName>_<toolName>`、description 透传、parameters 从远端 JSON Schema 转换（兼容 MewCode JsonSchema 结构）、execute 调 `tools/call` 并转 ToolResult（结构化错误含错误信息）
- F5: 生命周期 —— 懒连接 + 连接缓存（Map<serverName, Client>）；tools/list 失败该 Server 跳过并提示，不影响其他 Server；进程退出时关闭全部连接（kill 子进程）
- F6: 错误处理 —— Server 不可达 / 初始化失败 / 调用失败 → 结构化 ToolResult（`[MCP 错误] ...`），Agent 可调整策略

## 非功能需求

- N1: 启动不阻塞 —— 懒连接，启动时不连接任何 Server，无网络/进程等待
- N2: ${VAR} 展开 —— 变量不存在时保留原样并在注册时提示
- N3: 退出清理 —— 全部连接关闭，stdio 子进程终止

## 不做的事

- MCP 资源 / 提示词 / 采样能力
- Server 健康检查与自动重连
- 配置热重载
- 认证流程（OAuth）——headers 手动配置

## 验收标准

- AC1: 配置解析 —— 两层合并（项目盖用户）、stdio/http 两形态、${VAR} 展开、缺失字段报错
- AC2: stdio 连接 —— 用真实 MCP Server（测试用官方示例 echo server 或自建最小 server 脚本）→ 握手成功、tools/list 发现工具
- AC3: 工具注册 —— 远端工具以 `serverName_toolName` 注册进 registry，参数 schema 转换正确、描述透传
- AC4: Agent 调用 —— fake provider 调用远端工具 → tools/call 执行 → 结果回灌（ToolResult 正确）
- AC5: 故障隔离 —— 一个坏 Server（command 不存在）不阻塞其他 Server 注册与调用
- AC6: HTTP 传输 —— 自建最小 Streamable HTTP Server 或官方示例 → 连接、发现、调用链路通
- AC7: 回归 —— 全部现有测试绿（89 项 + 新增）
