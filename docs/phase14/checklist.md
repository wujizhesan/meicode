# MewCode Phase14 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 小组持久化（验证：createGroup 后目录结构 group.yaml/tasks.json/mail/members；重启 loadGroup 花名册/任务仍在）
- [ ] 任务 CRUD（验证：创建/分配/更新状态/查清单；depends_on 持久化）
- [ ] 消息系统（验证：点对点收发；已读标记；时间戳/摘要自动补；广播；**并发写不丢**（锁重试）；**锁过期覆盖**）
- [ ] 成员派生（验证：spawnMember 后成员工具集含 team_task/team_send；主入口工具集不含）
- [ ] 审批（验证：队员发计划 → 解析 APPROVE/DENY 首行 → 执行/调整）
- [ ] 空闲与恢复（验证：execute 后 status idle + IDLE 消息；resume 从磁盘恢复 History）
- [ ] coordinator（验证：配置+env 双锁缺一不生效；开启后 Lead 工具集无 write/edit；保留 run_command）

## 集成

- [ ] TeamManager 全链路（验证：spawnMember + assignTask + markMemberIdle 协作正常）
- [ ] git 合并（验证：两个成员 worktree 各自提交 → mergeAll 合并成功；冲突 → 回滚上报）
- [ ] cli/useStream（验证：TeamManager 初始化；coordinator 过滤生效）
- [ ] 回归（验证：P1-P13 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（179 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 双成员并行：创建小组 → spawn 两个成员（各自 worktree）→ Lead 拆两个独立任务派发 → 成员并行执行 → 完成后 mergeAll 合并成功
- [ ] 场景 2 · 依赖任务：任务 A 依赖任务 B → B 完成后 A 才执行
- [ ] 场景 3 · 审批：成员 needsApproval → 发计划 → Lead 回复 APPROVE → 成员继续
- [ ] 场景 4 · coordinator：配置 + `MEWCOORDINATOR=1` 启动 → Lead 无法写文件（write_file 被拒）但可读可跑命令

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 小组持久化 | 实现完整性第 1 条 |
| AC2 成员派生 | 实现完整性第 4 条 + 场景 1 |
| AC3 任务 CRUD | 实现完整性第 2 条 + 场景 2 |
| AC4 消息 | 实现完整性第 3 条 |
| AC5 审批 | 实现完整性第 5 条 + 场景 3 |
| AC6 空闲恢复 | 实现完整性第 6 条 |
| AC7 coordinator | 实现完整性第 7 条 + 场景 4 |
| AC8 git 合并 | 集成第 2 条 + 场景 1 |
| AC9 回归 | 集成第 4 条 |
