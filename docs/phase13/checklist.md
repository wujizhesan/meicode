# MewCode Phase13 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 创建（验证：真实 git 仓库 → `git worktree add` 成功，目录在 `.mewcode/worktrees/<name>/`，分支 `wt-<name>`）
- [ ] 名校验（验证：`.`/`..`/超长（>64）/非法字符/盘符（C:）/绝对路径全部拒绝；嵌套斜杠合法）
- [ ] 快速恢复（验证：目录已存在 → 复用不重复 add（`git worktree list` 无重复条目））
- [ ] 环境初始化（验证：node_modules junction 软链存在；.env/config.local 复制；worktree 可直接运行）
- [ ] exit 检测（验证：`git status --porcelain` 非空 → dirty；未推送 commit → dirty；干净 → 非 dirty）
- [ ] remove 保护（验证：dirty 时拒绝删除并返回原因；干净可删）
- [ ] cleanup（验证：伪造 >7 天且干净的 worktree → 被清；有变更的保留）

## 集成

- [ ] explicit cwd（验证：isolation 角色 spawn 时子 Agent 工具 ctx.cwd = worktree 路径；主目录文件不被修改）
- [ ] 隔离声明（验证：`isolation: worktree` 角色 → 自动建 worktree + system 注入路径说明；无声明角色不隔离）
- [ ] 完成后处理（验证：dirty → worktree 保留且 record 含路径/分支；干净 → 自动清理）
- [ ] 失败降级（验证：worktree 创建失败 → 子任务不隔离继续 + warn）
- [ ] 启动清理（验证：cli 启动时 cleanup 日志；过期 worktree 被清）
- [ ] 回归（验证：P1-P12 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（172 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 隔离：写 refactorer 角色（isolation: worktree）→ 让模型 spawn 它修改文件 → `.mewcode/worktrees/` 出现目录、主目录未被改
- [ ] 场景 2 · 保留合并：子 Agent 提交变更 → worktree 保留 → 主 Agent `git merge wt-refactorer` 成功
- [ ] 场景 3 · 自动清理：子 Agent 不改文件 → worktree 自动消失

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 创建+校验 | 实现完整性第 1、2 条 |
| AC2 快速恢复 | 实现完整性第 3 条 |
| AC3 环境初始化 | 实现完整性第 4 条 |
| AC4 explicit cwd | 集成第 1 条 + 场景 1 |
| AC5 隔离声明 | 集成第 2 条 |
| AC6 变更保护 | 实现完整性第 6 条 + 场景 2 |
| AC7 过期清理 | 实现完整性第 7 条 + 集成第 5 条 + 场景 3 |
| AC8 回归 | 集成第 6 条 |
