# MewCode Phase14 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/team/types.ts` | TeamMember/TeamTask/MailMessage/TeamGroup |
| 新建 | `src/team/group.ts` | 小组持久化（group.yaml/tasks.json） |
| 新建 | `src/team/mail.ts` | 邮箱（注册表/锁/读写/广播/协议） |
| 新建 | `src/team/member.ts` | MemberHost（协程驻留/持久 History） |
| 新建 | `src/team/tools.ts` | team_task/team_send 协作工具 |
| 新建 | `src/team/index.ts` | TeamManager（spawn/assign/mergeAll/coordinator） |
| 修改 | `src/cli.tsx` | TeamManager 初始化 |
| 修改 | `src/tui/useStream.ts` | coordinator 工具过滤 |
| 新建 | `test/team_test.ts` | 全量测试 |

## T0: 类型与小组持久化

**文件：** `src/team/types.ts`、`src/team/group.ts`
**依赖：** 无
**步骤：**
1. types.ts：TeamMember / TeamTask / MailMessage / TeamGroup
2. group.ts：createGroup（目录结构 group.yaml/tasks.json/mail/members）、loadGroup、addMember/removeMember、listTasks/updateTask（tasks.json 读写，带 .lock 复用 mail 锁或独立锁）

**验证：** team_test：创建目录结构；花名册读写；任务 CRUD 持久化（重启后仍在）

## T1: 邮箱系统

**文件：** `src/team/mail.ts`
**依赖：** T0
**步骤：**
1. 注册表：registry.json（name → 邮箱文件路径）
2. 锁：`mail/.lock`——写前创建（内容含时间戳）；已存在且 <5s → 重试 3 次后放弃报错；>5s → 过期覆盖
3. send(from, to, body)：目标邮箱 append JSONL（to='*' → broadcast.mail）；自动 ts/read:false/summary（正文首行截断 80 字）
4. read(name, markRead)：读自己邮箱 + broadcast.mail，过滤（to=name 或 from=name 或广播），按 ts 排序
5. 协议辅助：parseProtocol(body) → 首行 PROTO:/APPROVE/DENY 识别

**验证：** team_test：点对点收发；已读标记；广播；并发（两进程写不丢——锁重试）；锁过期覆盖；协议解析

## T2: 成员驻留

**文件：** `src/team/member.ts`
**依赖：** T0、T1
**步骤：**
1. MemberHost：history（持久 members/<name>.history.jsonl）、status、resume（从磁盘恢复）
2. execute(taskTitle)：runAgent（成员系统提示 + 协作工具 toolsOverride + 持久 history + maxRounds 15）→ 完成 → summary → markMemberIdle + IDLE 消息回 Lead
3. 持久化：每轮执行后 history 落盘（追加 JSONL）

**验证：** team_test：fake provider——execute 后 history 持久化；resume 恢复；完成后 status idle + IDLE 消息发出

## T3: 协作工具

**文件：** `src/team/tools.ts`
**依赖：** T0-T2
**步骤：**
1. team_task：action=list|create|update|status；参数 id/title/assignee/depends_on → group.tasks 操作（带锁）
2. team_send：to/body → mail.send；body 协议标记透传
3. 工具名/描述清晰（模型可理解）

**验证：** team_test：任务创建/分配/状态更新；发送消息落盘；工具参数校验

## T4: TeamManager

**文件：** `src/team/index.ts`
**依赖：** T0-T3
**步骤：**
1. TeamManager：createGroup/loadGroup/spawnMember/assignTask/listTasks/updateTask/markMemberIdle
2. isCoordinator：配置（team.yaml coordinator_enabled）+ env（MEWCOORDINATOR）双锁
3. mergeAll(group)：遍历成员 workdir（worktree）→ git merge wt-<name> → 冲突自动解决（按文件 checkout --ours/theirs）→ 失败回滚（merge --abort）+ 上报
4. createLeadTools：coordinator 开启时过滤 write/edit（返回工具集）

**验证：** team_test：spawnMember + assignTask（fake 成员执行）；coordinator 双锁（配置缺一不生效）；mergeAll（两个 worktree 各自提交 → 合并成功；冲突 → 回滚上报）

## T5: 集成

**文件：** `src/cli.tsx`、`src/tui/useStream.ts`
**依赖：** T4
**步骤：**
1. cli：TeamManager 创建（读 team.yaml 配置）→ 传给 App
2. useStream：coordinator 开启时 Lead 的 toolsOverride 移除 write/edit（保留 read + run_command + spawn）

**验证：** tsc；tui_smoke 不崩

## T6: 测试全量

**文件：** `test/team_test.ts`
**依赖：** T0-T5
**步骤：**
1. team_test 全量（T0-T4 用例）
2. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P14 全部用例）

## T7: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T6
**步骤：**
1. 创建小组 → spawn 两个成员（各自 worktree）→ Lead 拆任务（带依赖）派发 → 成员并行执行 → 完成后 git 合并
2. 审批：成员 needsApproval → 计划 → Lead APPROVE → 继续
3. coordinator：配置 + env 开启 → Lead 无法写文件

**验证：** 团队全链路

## 执行顺序

```
T0 → T1/T2 → T3 → T4 → T5 → T6 → T7
```

依赖链：T1 需 T0；T2 需 T0+T1；T3 需 T0-T2；T4 需 T0-T3；T5 需 T4；T6 需全部；T7 需 T6。
