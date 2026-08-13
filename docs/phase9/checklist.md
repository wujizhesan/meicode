# MewCode Phase9 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 注册中心（验证：登记十命令元数据齐全；构造时注入别名冲突 → register 抛错）
- [ ] 解析器（验证：`/HELP x y` → help+[x,y]；`/` 与空输入返回非命令；`你好` 非命令；未知命令 → showMessage 含 `/help`）
- [ ] 三类分发（验证：local 命令不触发任何 send；prompt 命令触发 sendUserMessage 一次）
- [ ] UiController 解耦（验证：mock ui 可独立驱动全部命令 handler）
- [ ] Tab 补全（验证：单匹配补全；多匹配（/m → /memory /mode）菜单；hidden 命令不出现）

## 集成

- [ ] 分流器（验证：`/status` 走命令分支；`你好` 走对话分支——dispatch 返回值断言）
- [ ] 模式联动（验证：/plan /do 后状态栏模式标记切换）
- [ ] /clear 语义（验证：清空后对话历史空，但 sessions JSONL 文件仍在）
- [ ] /session 别名（验证：/resume 与 /session 等价，行为不变）
- [ ] 回归（验证：P1-P8 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（125 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 十命令逐个：/help（列表）→ /status（状态）→ /compact（压缩提示）→ /clear（历史清空）→ /plan（[PLAN] 标记）→ /do（回 [DEFAULT]）→ /session（列表）→ /memory（笔记）→ /permission（模式）→ /review（AI 审查 git 变更）
- [ ] 场景 2 · Tab 补全：输 `/s` Tab → 补全 /session；输 `/m` Tab → 菜单选择
- [ ] 场景 3 · 大小写：/HELP 与 /help 等效
- [ ] 场景 4 · 未知命令：/xyz → 提示「未知命令，输入 /help」

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 注册中心 | 实现完整性第 1 条 |
| AC2 解析器 | 实现完整性第 2 条 + 场景 3、4 |
| AC3 三类分发 | 实现完整性第 3 条 |
| AC4 UiController | 实现完整性第 4 条 |
| AC5 分流器 | 集成第 1 条 |
| AC6 Tab 补全 | 实现完整性第 5 条 + 场景 2 |
| AC7 十命令 | 集成第 2、3、4 条 + 场景 1 |
| AC8 回归 | 集成第 5 条 |
