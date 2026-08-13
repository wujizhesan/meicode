# MewCode Phase13 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/worktree/types.ts` | WorktreeInfo |
| 新建 | `src/worktree/validate.ts` | 目录名校验 |
| 新建 | `src/worktree/manager.ts` | WorktreeManager（create/exit/remove/cleanup/初始化） |
| 新建 | `src/worktree/index.ts` | 导出 |
| 修改 | `src/subagent/types.ts` | AgentRole 加 isolation |
| 修改 | `src/subagent/manager.ts` | worktree 集成（spawn 时建/注入/完成后处理） |
| 修改 | `src/cli.tsx` | WorktreeManager 创建 + 启动清理 |
| 新建 | `test/worktree_test.ts` | 全量测试 |

## T0: 类型与名校验

**文件：** `src/worktree/types.ts`、`src/worktree/validate.ts`
**依赖：** 无
**步骤：**
1. types.ts：WorktreeInfo（name/path/branch/createdAt/dirty）
2. validate.ts：`validateWorktreeName(name)`——字符集 `^[a-zA-Z0-9_/-]{1,64}$`；split('/') 任一段为 '.'/'..' 拒绝；绝对路径/盘符（`/` 开头、`\`、`:`）拒绝

**验证：** worktree_test：合法名通过；`.`/`..`/超长/非法字符/盘符/绝对路径拒绝；嵌套斜杠合法

## T1: WorktreeManager

**文件：** `src/worktree/manager.ts`
**依赖：** T0
**步骤：**
1. create(name)：
   - validate → 非法抛错
   - 路径 = `<repo>/.mewcode/worktrees/<name>`；已存在 → `git worktree list` 校验在册 → 复用（只读）
   - 否则 `git worktree add <path> -b wt-<name>`（spawn git）
   - 环境初始化：主 node_modules 存在 → `fs.symlinkSync(..., 'junction')`；复制主目录 `.env*`、`config.local.*`（glob）；hooks 天然共享（注释说明）
2. exit(name)：`git -C <path> status --porcelain` 非空 → dirty；`git log origin/HEAD..wt-<name>` 有 commit → dirty
3. remove(name)：exit → dirty → 返回拒绝原因；否则 `git worktree remove <path>` + 清理空目录
4. cleanup(days=7)：扫描根 → exit → 非 dirty 且超期 → remove
5. isManagedPath(p)：resolve 后前缀校验 + 名校验 + `git worktree list` 在册

**验证：** worktree_test（真实 git 仓库 fixture）：创建成功（目录/分支）；已存在复用（git worktree list 不重复）；exit 检测 dirty；dirty 拒删；cleanup 删过期留新；isManagedPath 三层

## T2: subagent 集成

**文件：** `src/subagent/types.ts`、`src/subagent/manager.ts`
**依赖：** T1
**步骤：**
1. AgentRole 加 `isolation?: 'worktree'`
2. SubAgentManager 构造可选 worktreeManager；spawn 时 role.isolation === 'worktree'：
   - create（失败降级：不隔离 + console.warn）
   - subCtx.cwd = worktree.path
   - system prompt 追加工作目录说明
   - run 结束后：exit → dirty → 保留（record 附加 worktree 路径/分支）→ 干净 → remove

**验证：** subagent_test：isolation 角色 spawn 时 ctx.cwd 为 worktree 路径（fake 断言）；dirty 保留/干净清理；无 worktreeManager 时不隔离

## T3: cli 初始化与缓存补漏

**文件：** `src/cli.tsx`
**依赖：** T1
**步骤：**
1. WorktreeManager 创建（repoRoot = `git rev-parse --show-toplevel` spawn）→ 启动 cleanup（>7 天）
2. 缓存确认：P7 ContextManager/记忆/指令等均用 ctx.cwd 绝对路径（grep 确认 join(cwd) 模式）；补漏（如有相对路径处改绝对）

**验证：** tsc；cli 启动 worktree 清理日志

## T4: 测试全量

**文件：** `test/worktree_test.ts`、`test/subagent_test.ts`
**依赖：** T0-T3
**步骤：**
1. worktree_test 全量
2. subagent_test 加 isolation 用例
3. 全量回归

**验证：** tsc 0 错误；npm test 全绿（P1-P13 全部用例）

## T5: 真机验证（用户配合）

**文件：** 无（验证）
**依赖：** T4
**步骤：**
1. 写一个 isolation: worktree 的角色（如 refactorer）→ 让模型 spawn 它改文件 → 检查 `.mewcode/worktrees/` 出现目录、主目录未被改
2. 让子 Agent 提交变更 → worktree 保留待合并 → 主 Agent git merge 成功
3. 让子 Agent 不改任何东西 → worktree 自动清理

**验证：** 隔离/保留合并/清理三条路径

## 执行顺序

```
T0 → T1 → T2/T3 → T4 → T5
```

依赖链：T1 需 T0；T2 需 T1；T3 需 T1；T4 需全部；T5 需 T4。
