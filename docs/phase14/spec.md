# MewCode Phase14 Spec — 团队编排（Team Lead）

## 背景

P1-P13 已交付多子 Agent + Worktree 隔离，但子任务委派是一次性的（spawn 后完事）。本阶段把主 Agent 升级为 Team Lead：创建长期团队、派生多个队员并行干活，队员通过共享任务清单和邮箱直接协作（不经 Lead 中转），支持 coordinator 模式专注派人与决策。

## 目标

- 小组（Group）长期对象：成员花名册、任务清单、邮箱、持久化
- 成员协程后端长期驻留（消息唤醒恢复上下文）
- 协作工具（任务 CRUD + 点对点消息）仅队员可见
- 审批协议（首行标记 APPROVE/DENY）
- Lead 拆任务派活 + 完成后 git 合并
- coordinator 模式（两把锁）剥夺写文件权

## 功能需求

- F1: 小组对象 —— `TeamGroup`：名称、负责人、成员花名册（角色/工作目录/运行后端/是否要审批）、任务清单、持久化位置；数据存 `<cwd>/.mewcode/team/<group>/`（group.yaml 元数据 + tasks.json 任务 + mail/ 邮箱）
- F2: 成员运行后端 —— 第一版协程后端：同进程长期驻留的 Agent 实例（持久 History + 协作工具集）；独立终端窗格后端留接口（环境检测与显式降级提示），不静默降级
- F3: 协作工具（仅队员可见）—— `team_task`（共享任务增删查改，带依赖字段）、`team_send`（点对点发消息）；主入口和普通子 Agent 看不到这两个工具（工具过滤）；要审批的队员先发计划给 Lead，Lead 回首行协议标记（`APPROVE <理由>` / `DENY <理由>`）后再执行
- F4: 消息系统 —— 两段式：名称注册表（成员名 → 邮箱文件路径）+ 邮箱文件（JSONL 追加，每条含发件人/正文/时间戳/已读/摘要）；落盘自动补时间戳、默认未读；**锁文件保证并发安全**（拿不到锁重试，锁太旧视为过期）；支持广播（发给全员）与结构化协议消息（首行 `PROTO:<type>`）
- F5: Team Lead 发起流程 —— 用户目标 → 拆成带依赖的任务写入共享清单 → 派生成员（每成员一个任务或子集）→ 并行执行 → 全部完成后 git 合并各成员工作目录（worktree）→ 能解决的冲突自动解决、搞不定回滚并上报
- F6: 成员生命周期 —— 干完自然停 → 标记空闲 → 通知 Lead（`IDLE` 协议消息）；Lead 发消息（`ASSIGN`）→ 成员从磁盘恢复上下文继续执行（不重新 spawn）
- F7: coordinator 模式 —— 两把锁：配置开关（team.yaml `coordinator_enabled: true`）+ 环境变量（`MEWCOORDINATOR=1`）；开启后剥夺 Lead 的写文件工具（write_file/edit_file 从工具集移除），保留读类 + run_command（跑 git 合并），只留派人/终止/发消息/合并

## 非功能需求

- N1: 消息并发安全（锁文件 + 重试 + 过期判定）
- N2: 后端选择不静默降级（协程/窗格检测失败显式提示）
- N3: 成员上下文可恢复（磁盘持久化，Lead 指派即恢复）

## 不做的事

- 跨机器分布式团队
- 成员间实时流式通信
- 复杂任务依赖约束（只支持简单 depends_on 字段）

## 验收标准

- AC1: 小组创建与持久化 —— group.yaml/tasks.json/mail/ 目录结构正确；成员花名册（角色/目录/后端/审批标志）
- AC2: 成员派生 —— 派生成员（协程驻留），工具集含 team_task/team_send；主入口工具集不含
- AC3: 任务 CRUD —— 创建/分配/更新状态/查清单，depends_on 字段持久化
- AC4: 消息 —— 点对点发送/读取（已读标记/时间戳/摘要）；广播；锁并发（两进程同时写不丢消息）；锁过期判定
- AC5: 审批 —— 队员发计划 → Lead APPROVE/DENY → 队员解析后执行/调整
- AC6: 空闲与恢复 —— 成员完成 → IDLE 通知；Lead ASSIGN → 从磁盘恢复上下文继续（fake 断言 History 恢复）
- AC7: coordinator —— 配置+环境变量两把锁缺一不生效；开启后 Lead 工具集无 write/edit；保留 run_command
- AC8: git 合并 —— 两个成员 worktree 各自提交 → Lead 合并成功；冲突时回滚上报
- AC9: 回归 —— 全部现有测试绿

## 目录结构

```
<cwd>/.mewcode/team/<group>/
├── group.yaml          — 名称/负责人/成员花名册
├── tasks.json          — 共享任务清单（含 depends_on）
└── mail/
    ├── registry.json   — 成员名 → 邮箱文件路径
    ├── <name>.mail     — 每人邮箱（JSONL，锁文件 .lock）
    └── .lock           — 写锁（过期判定）
```
