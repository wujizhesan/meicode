# MewCode Phase4 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 七模块拼装正确（验证：buildSystemPrompt('full') 输出按 priority 顺序、空行分隔、环境信息不在其中）
- [ ] 前缀稳定（验证：fake provider 捕获连续两轮请求，主 system 消息字节完全一致）
- [ ] 环境分流（验证：主 system 不含 cwd/日期；独立环境 system 消息含 cwd）
- [ ] 轮次注入（验证：5 轮循环——第 1/4 轮全量注入、第 2/3 轮精简；模式切换后首轮全量）
- [ ] 双重强化（验证：至少 2 条关键规则关键词同时存在于系统提示与工具 description）
- [ ] cache 字段解析（验证：fake usage 含 cache 字段 → 事件携带正确；缺失 → undefined 不崩）

## 集成

- [ ] 三段式消息组装（验证：每轮请求 messages 结构 = [主 system, 环境 system, (轮次 system), ...历史]）
- [ ] UI 缓存命中率（验证：命中率状态行出现且随轮次上升；无 cache 数据时不显示）
- [ ] P3 功能回归（验证：/plan /do 行为不变，loop_test 旧用例全绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（P1-P4 全部用例）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 缓存生效：连续 3 轮以上对话 → 状态行出现缓存命中率且逐轮上升（同前缀复用）
- [ ] 场景 2 · 行为无回归：问「读一下 D:\MewCode\package.json」→ 工具调用正常（双重强化后模型行为不退化）
- [ ] 场景 3 · 对比记录：同一任务在结构化前后各跑一次，响应速度/token 对比写入 docs/phase4/cache_eval.md

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 模块拼装 | 实现完整性第 1 条 |
| AC2 前缀稳定 | 实现完整性第 2 条 |
| AC3 环境分流 | 实现完整性第 3 条 |
| AC4 双重强化 | 实现完整性第 5 条 |
| AC5 轮次注入 | 实现完整性第 4 条 |
| AC6 缓存验证 | cache 字段解析 + 场景 1、3 |
| AC7 回归 | 集成第 3 条 + 场景 2 |
