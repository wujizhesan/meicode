# MewCode Phase5 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 黑名单拦截（验证：`rm -rf /`、`del /s /q C:\` 等命中拒绝；`git status`、`node -v` 放行）
- [ ] 路径沙箱（验证：cwd 内读写正常；符号链接指向外部 → 拒绝；深层不存在路径不误伤）
- [ ] 规则引擎（验证：`run_command(git *)` 匹配 git 命令；deny 拦截；`read_file(src/**)` glob）
- [ ] 三层优先级（验证：会话 > 本地 > 项目 > 用户；同层 deny 优先 allow）
- [ ] 权限模式（验证：strict 未 allow 即拒不弹窗；permissive 仅黑名单；default 未命中弹窗）
- [ ] 永久放行（验证：P 键后项目级 rules.yaml 出现对应 allow 规则）

## 集成

- [ ] 拒绝不终止（验证：fake permission deny → tool 结果含 `[权限拒绝]` 且循环最终 complete）
- [ ] 人在回路四态（验证：once 放行一次、session 后续轮次直接放行、forever 写文件、Esc 拒绝）
- [ ] 弹窗模态（验证：弹窗期间输入禁用，Enter/S/P/Esc 响应正确）
- [ ] `/mode` 命令（验证：`/mode strict` 后行为切换；非法参数提示）
- [ ] 回归（验证：P1-P4 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（P1-P5 全部用例）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 黑名单：让模型「执行 del /s /q C:\Windows\temp\*.log」→ 执行前被拒，回复体现 `[权限拒绝]`，Agent 继续工作不崩
- [ ] 场景 2 · 模式切换：`/mode strict` 后让模型读 cwd 外文件 → 拒绝；`/mode permissive` 后同一操作放行（黑名单仍拦）
- [ ] 场景 3 · 弹窗四态：default 模式让模型执行未规则化的命令 → 弹窗：Enter 本次放行执行、再触发 → S 会话放行、再触发 → P 永久放行并检查项目级 rules.yaml、再触发 → Esc 拒绝并看模型调整
- [ ] 场景 4 · 沙箱：让模型读 cwd 外的文件（如 C:\Windows\win.ini）→ 越界拒绝（permissive 下放行）

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 黑名单 | 实现完整性第 1 条 + 场景 1 |
| AC2 沙箱 | 实现完整性第 2 条 + 场景 4 |
| AC3 规则 | 实现完整性第 3 条 |
| AC4 三层优先级 | 实现完整性第 4 条 |
| AC5 模式 | 实现完整性第 5 条 + 场景 2 |
| AC6 人在回路 | 集成第 1、2 条 + 场景 3 |
| AC7 回归 | 集成第 5 条 |
