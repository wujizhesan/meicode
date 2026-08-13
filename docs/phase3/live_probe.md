# P3-T0 真机冒烟结论（2026-08-08）

**环境**：DeepSeek V4 Flash（`https://api.deepseek.com`，model `deepseek-v4-flash`），真实 key

## ① include_usage 兼容性

- 结果：**HTTP 200，usage chunk 正常出现**
- 结论：`stream_options: { include_usage: true }` 受支持 → T2 保留该字段，usage 事件可用

## ② 模型工具调用行为

- 结果：**工具调用 1 次**（read_file），无错误，模型本轮无文本（纯工具调用）
- 结论：DeepSeek 在 system prompt 引导下会主动调工具；**第一轮纯工具调用无文本是常态**——ReAct 循环必须正确处理「无文本 + 有工具调用」的轮次（UI 不显示空回复）

## 对设计的影响

1. T2：include_usage 直接实现（无降级路径）
2. T3：runAgent 对「纯工具调用轮」的 assistant 消息 content 为空是正常情况（P2 已处理：tool_calls 元数据 + 空 content）
3. 探针显示模型一次调用一个工具——多工具同批（并发）触发场景较少，T4 的并发测试用 fake provider 保证覆盖
