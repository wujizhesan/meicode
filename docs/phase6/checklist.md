# MewCode Phase6 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 配置解析（验证：两层合并项目盖用户；`${VAR}` 展开与缺失保留两态；缺 type/command 的坏条目跳过并提示）
- [ ] stdio 连接（验证：fixture echo server → discoverAll ok 列表含 server 名）
- [ ] HTTP 连接（验证：http fixture → 发现 + 调用链路通）
- [ ] 工具注册（验证：registry 含 `testserver_echo`；parameters 含 text 字段；description 透传）
- [ ] 工具调用（验证：callTool echo 往返返回正确文本；isError 转结构化错误）
- [ ] 故障隔离（验证：坏 Server + 好 Server 并行 → 好 Server 正常注册调用）
- [ ] 连接缓存（验证：重复 discoverAll 不重连——连接计数不变）

## 集成

- [ ] Agent 调用远端工具（验证：fake provider 调 `testserver_echo` → ToolResult 回灌 → 循环继续）
- [ ] 懒发现（验证：启动进界面零连接；首次 send 前才触发发现；失败 Server 提示但不阻塞对话）
- [ ] 退出清理（验证：closeAll 后 stdio 子进程终止——进程列表无残留）
- [ ] 回归（验证：P1-P5 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（89 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 发现：配置里声明一个 MCP Server（fixture 或官方示例）→ 启动 → 首次提问后远端工具出现在模型可调工具集（回复或状态可见）
- [ ] 场景 2 · 调用：让模型「用 echo 工具回显 hello」→ 工具调用 → 结果回灌 → 回复体现 echo 输出
- [ ] 场景 3 · 隔离：同时配置一个坏 Server（command 不存在）→ 启动不阻塞、好 Server 正常工作、坏 Server 有提示

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 配置解析 | 实现完整性第 1 条 |
| AC2 stdio 连接 | 实现完整性第 2 条 |
| AC3 工具注册 | 实现完整性第 4 条 |
| AC4 Agent 调用 | 集成第 1 条 + 场景 2 |
| AC5 故障隔离 | 实现完整性第 6 条 + 场景 3 |
| AC6 HTTP 传输 | 实现完整性第 3 条 |
| AC7 回归 | 集成第 4 条 |
