# MewCode Phase12 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 角色加载（验证：frontmatter 解析；项目 > 用户 > 内置覆盖；坏文件跳过）
- [ ] defined 启动（验证：空 History + 角色 system 提示；maxRounds/permission 生效）
- [ ] fork 启动（验证：继承父历史尾部 + 父工具集）
- [ ] 工具过滤（验证：白名单收窄；黑名单排除；**spawn_agent 默认移除**（白名单显式含才保留）；load_skill 保留）
- [ ] 后台三方式（验证：async 立即后台；30s 超时自动转后台（fake 慢 agent）；fork 强制后台）
- [ ] 状态追踪（验证：记录 running → done/error，含 tokens 与结果）

## 集成

- [ ] spawn_agent 工具（验证：sync 返回子结果；async 返回「已提交后台 任务ID」）
- [ ] 结果回流（验证：子任务完成 → 主对话出现 `📦 [子任务 <role>]` 摘要消息）
- [ ] P11 对接（验证：hook subagent 动作触发真实 spawn）
- [ ] 嵌套防护（验证：子 Agent 请求的工具列表不含 spawn_agent）
- [ ] 回归（验证：P1-P11 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（164 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · defined：让模型「用 code-reviewer 角色审查最近的 git 变更」→ spawn_agent 被调 → 子 Agent 跑 → 「📦 [子任务 code-reviewer] 结果」回流
- [ ] 场景 2 · 自建角色：`D:\MewCode\agents\my-agent.md` 写一个角色 → 重启 → 可用
- [ ] 场景 3 · 嵌套防护：子 Agent 会话中模型尝试 spawn → 工具不存在被拒

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 角色加载 | 实现完整性第 1 条 + 场景 2 |
| AC2 defined | 实现完整性第 2 条 + 场景 1 |
| AC3 fork | 实现完整性第 3 条 |
| AC4 嵌套防护 | 实现完整性第 4 条 + 集成第 4 条 + 场景 3 |
| AC5 后台管理 | 实现完整性第 5、6 条 |
| AC6 结果回流 | 集成第 2 条 + 场景 1 |
| AC7 P11 对接 | 集成第 3 条 |
| AC8 回归 | 集成第 5 条 |
