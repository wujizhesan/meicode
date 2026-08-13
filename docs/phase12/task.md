# MewCode Phase12 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/subagent/types.ts` | AgentRole/SpawnRequest/SubAgentRecord |
| 新建 | `src/subagent/loader.ts` | 角色四来源加载 + frontmatter + 覆盖 |
| 新建 | `src/subagent/manager.ts` | SubAgentManager（spawn/过滤/后台/记录） |
| 新建 | `src/subagent/index.ts` | createSpawnAgentTool + runSubAgent |
| 新建 | `src/agents/code-reviewer.md` | 内置角色样板 |
| 修改 | `src/hook/runner.ts` | subagent 动作对接真实 spawn |
| 修改 | `src/tui/useStream.ts` | 结果回流 |
| 修改 | `src/cli.tsx` | SubAgentManager 初始化 + 注册 |
| 新建 | `test/subagent_test.ts` | 全量测试 |

## T0: 类型与角色加载器

**文件：** `src/subagent/types.ts`、`src/subagent/loader.ts`
**依赖：** 无
**步骤：**
1. types.ts：AgentRole / SpawnRequest / SubAgentRecord / SubAgentStatus
2. loader.ts：四来源（项目 agents/ > 用户 ~/.mewcode/agents/ > 内置 src/agents/）；frontmatter 解析（name/description 必需；toolsAllow/toolsDeny/model/maxRounds/permission 可选）；同名覆盖；坏文件跳过

**验证：** subagent_test：frontmatter 解析；四来源覆盖（项目盖内置）；坏文件跳过

## T1: SubAgentManager

**文件：** `src/subagent/manager.ts`
**依赖：** T0
**步骤：**
1. loadRoles / getRole / listRecords / getRecord / setOnResult
2. spawn 分流：
   - defined：role 存在校验；空 History；system=角色 content；maxRounds=角色??10；permission=角色??继承
   - fork：parentHistory 尾部 N 条（默认 10）+ parentTools 过滤
3. filterTools：①基础集（白名单或父工具）②黑名单排除 ③spawn_agent 默认移除（白名单显式含才保留）④系统工具（load_skill 如有）保留
4. 后台分流：async/fork 立即后台；否则同步等待 30s 超时转后台
5. runSubAgent：复用 runAgent（maxIterations=角色轮次；toolsOverride=过滤后）→ complete 完成 → 输出 → LLM 摘要 → 记录 + onResult

**验证：** subagent_test：defined 启动（History 空/system 正确/工具过滤）；filterTools 三防线（嵌套移除/黑名单/白名单保留）；后台 async；30s 超时转后台（fake 慢 agent）；记录状态 running→done；摘要回调

## T2: spawn_agent 工具与内置角色

**文件：** `src/subagent/index.ts`、`src/agents/code-reviewer.md`
**依赖：** T1
**步骤：**
1. createSpawnAgentTool：参数 type/role/prompt/async；execute → manager.spawn → 返回（sync 结果或「已提交后台 任务ID」）
2. code-reviewer.md 内置角色（审查代码，toolsAllow [run_command, read_file, grep_code]，toolsDeny [write_file]，maxRounds 10）
3. runSubAgent 导出

**验证：** subagent_test：工具执行（fake manager）sync/async 返回；角色样板可加载

## T3: P11 对接

**文件：** `src/hook/runner.ts`
**依赖：** T2
**步骤：**
1. runSubagentAction 从占位改为：调用传入的 spawn 函数（manager.spawn(defined, role, async)）
2. HookEngine/runner 需要访问 SubAgentManager——通过构造注入或闭包

**验证：** subagent_test：fake hook 触发 spawn 被调

## T4: useStream 回流 + cli 初始化

**文件：** `src/tui/useStream.ts`、`src/cli.tsx`
**依赖：** T1
**步骤：**
1. useStream：subAgentManager.setOnResult → 主对话 push `📦 [子任务 <role>] 结果` 消息 + history push
2. cli：SubAgentManager 创建 + loadRoles（内置/用户/项目）+ 注册 spawn_agent 工具 + 传给 App/useStream + hook runner 注入

**验证：** tsc；tui_smoke 不崩

## T5: 测试全量

**文件：** `test/subagent_test.ts`
**依赖：** T0-T4
**步骤：**
1. subagent_test 全量（T0-T3 用例）
2. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P12 全部用例）

## T6: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T5
**步骤：**
1. 启动 → 让模型「用 code-reviewer 角色审查最近的变更」（spawn_agent defined）→ 子 Agent 跑 → 结果回流
2. 自建角色 agents/my-agent.md → 重启可用
3. 嵌套防护：子 Agent 工具集不含 spawn_agent

**验证：** 子任务全链路

## 执行顺序

```
T0 → T1 → T2 → T3/T4 → T5 → T6
```

依赖链：T1 需 T0；T2 需 T1；T3 需 T2；T4 需 T1；T5 需全部；T6 需 T5。
