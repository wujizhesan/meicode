# MewCode Phase11 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 加载与校验（验证：合法规则加载；缺 event/action 跳过+警告；tool_before 配 async 报错；项目覆盖用户两层合并）
- [ ] 事件触发（验证：fire 各事件（session/round/message/tool/app）→ 对应规则被调）
- [ ] tool_before 拦截（验证：条件命中 → 返回 `[Hook 拦截]`；未命中 null 放行）
- [ ] 条件语法（验证：精确/反向（!）/正则（/re/）/glob 各匹配；all 全真、any 一真；`args.command` 深层取值）
- [ ] 四动作（验证：command 执行有输出；inject_prompt 进入注入缓冲；http 被 fake server 收到；subagent 占位日志）

## 集成

- [ ] round_start 注入（验证：loop 请求 msgs 含注入的独立 system 消息）
- [ ] 拦截回灌（验证：intercept 命中 → executeOne 返回 `[Hook 拦截]` 结构化结果 → 模型收到）
- [ ] once 执行控制（验证：同会话第二次触发不重复执行）
- [ ] async 与超时（验证：async 动作不阻塞主流程；command 超时（>10s）被杀并记日志）
- [ ] 失败隔离（验证：Hook 抛异常/超时后 Agent 主流程继续，后续事件正常触发）
- [ ] message/session/app 事件（验证：send 后 message 触发；cli 启动 session_start/app_start）
- [ ] 回归（验证：P1-P10 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（154 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 注入：`.mewcode/hooks.yaml` 配 round_start inject「每轮先确认测试状态」→ 对话中模型行为体现该提示
- [ ] 场景 2 · 拦截：tool_before 拦 `run_command` 的 `del *` → 让模型执行删除命令 → 被 `[Hook 拦截]` 挡住且模型调整
- [ ] 场景 3 · 失败隔离：写一条必然超时的 hook（ping -n 100）→ Agent 正常运行不受影响

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 加载校验 | 实现完整性第 1 条 |
| AC2 事件触发 | 实现完整性第 2 条 |
| AC3 拦截回灌 | 实现完整性第 3 条 + 集成第 2 条 + 场景 2 |
| AC4 条件语法 | 实现完整性第 4 条 |
| AC5 四动作 | 实现完整性第 5 条 + 场景 1 |
| AC6 执行控制 | 集成第 3、4 条 |
| AC7 失败隔离 | 集成第 5 条 + 场景 3 |
| AC8 回归 | 集成第 7 条 |
