# MewCode Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] cli 入口已实现且可启动（验证：`node src/cli.ts --config <path>` 进入界面不崩）
- [ ] config 加载校验生效（验证：对缺失字段/非法 protocol 配置运行，启动即报对应错误）
- [ ] Anthropic Provider 已实现（验证：fake server + 官方 SSE 样例，StreamEvent 序列正确）
- [ ] OpenAI Provider 已实现（验证：fake server + OpenAI SSE 样例，StreamEvent 序列正确）
- [ ] Provider 工厂按 protocol 分派正确（验证：两种配置各返回对应实现）
- [ ] 会话历史全量传递（验证：N 轮后请求体中消息数与 N 一致）

## 集成

- [ ] 流事件完整生命周期：text/thinking/done/error 四类都被 TUI 正确处理（验证：对含 thinking 的样例流运行，思考区与正文区分别完整渲染；对中断流运行，显示错误行不崩溃）
- [ ] 一轮完整对话后历史正确追加（验证：单轮对话后 history 包含 user 消息 + 完整 assistant 消息，与回复逐字一致）
- [ ] TUI 与 Provider 解耦（验证：切换 anthropic/openai 配置，同一界面流程均工作，无 Provider 特有代码泄漏到界面层）

## 编译与测试

- [ ] `npx tsc --noEmit` 无错误（验证：运行命令，exit 0）
- [ ] 无运行时依赖 Node 24 之外能力（验证：仅用 `node` 命令启动，无构建步骤）

## 端到端场景（需真实 API key，用户提供 `~/.mewcode/config.yaml`）

- [ ] 场景 1 · 基本对话：启动 → 问「用一句话介绍你自己」→ 回复**逐字**出现（非整段闪现）→ 完整显示
- [ ] 场景 2 · 多轮记忆：先问「我叫小明，记一下」，再问「我叫什么？」→ 答出小明
- [ ] 场景 3 · 流式体验：长回复提问（如「写一首诗」）→ 首个 token 在 3 秒内出现，文字持续增量渲染
- [ ] 场景 4 · thinking：配置 thinking: true 提问 → 思考过程完整呈现在暗色区，正文区随后正常显示
- [ ] 场景 5 · OpenAI 后端：切换配置为 OpenAI → 场景 1 流程同样通过
- [ ] 场景 6 · 退出：对话中按 Ctrl+C → 界面干净退出，无报错堆栈

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 启动出现对话界面 | 实现完整性第 1 条 + 场景 1 前半 |
| AC2 Anthropic 流式逐字 | 场景 1 + 场景 3 |
| AC3 OpenAI 可对话 | 场景 5 |
| AC4 多轮记忆 | 场景 2 |
| AC5 thinking 完整呈现 | 场景 4 |
| AC6 配置错误清晰报错 | 实现完整性第 2 条 |
| AC7 Ctrl+C 干净退出 | 场景 6 |
