# MewCode Phase10 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] Skill 解析（验证：frontmatter 字段齐全；正文 SOP 保留；`{{param}}` 在激活时被替换）
- [ ] 三级覆盖（验证：项目同名 Skill 覆盖内置；用户级覆盖内置；缺层跳过）
- [ ] 坏文件跳过（验证：坏 frontmatter / 缺 name 文件 → skipped 列表且不影响其他 Skill）
- [ ] 两阶段（验证：启动索引仅 name+description；load_skill 后完整指令与白名单生效）
- [ ] 激活注入（验证：activePrompt 含完整指令且参数已替换；多 Skill 激活按顺序拼接）
- [ ] 白名单（验证：激活后 toolsOverride 仅含白名单并集+系统工具+load_skill；未知工具警告跳过该 Skill）
- [ ] 三样板（验证：commit/review/test 可被 loader 解析，mode/tools 正确）

## 集成

- [ ] load_skill 系统级（验证：白名单收窄时 load_skill 始终在 tools 里）
- [ ] isolated 模式（验证：runIsolated 独立会话（≤8 轮）→ LLM 摘要回流主历史）
- [ ] 斜杠动态注册（验证：激活后 `/<skill名>` 命令可用）
- [ ] /clear 清理（验证：清空历史后 skillManager.clear() 被调，激活 Skill 消失）
- [ ] /review 迁移（验证：命令系统无 /review；review skill 提供同等能力）
- [ ] 回归（验证：P1-P9 全部用例绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（140 + 新增全量）

## 端到端场景（真实 DeepSeek，`npm start`）

- [ ] 场景 1 · 索引：启动后对话中可见「可用 Skills: commit/review/test」列表（两阶段第一阶段）
- [ ] 场景 2 · /commit：激活并执行 → 模型按 SOP 提交当前 git 变更 → 提交成功且报告
- [ ] 场景 3 · /test（isolated）：独立会话跑 npm test → 摘要回流主对话 → 界面显示「[Skill test 结果]」摘要
- [ ] 场景 4 · 白名单：激活 commit 后模型只用 run_command/read_file/edit_file（不出现其他工具）
- [ ] 场景 5 · /clear：清空历史后激活 Skill 消失（再发消息不再有 Skill 指令）
- [ ] 场景 6 · 自建：项目 `skills/my-skill.md` 写一个简单 skill → 重启出现 → 加载可用

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 解析 | 实现完整性第 1 条 |
| AC2 三级覆盖 | 实现完整性第 2、3 条 |
| AC3 两阶段 | 实现完整性第 4 条 + 场景 1 |
| AC4 激活注入 | 实现完整性第 5 条 |
| AC5 执行模式 | 集成第 2 条 + 场景 3 |
| AC6 白名单 | 实现完整性第 6 条 + 集成第 1 条 + 场景 4 |
| AC7 斜杠/清理/样板 | 集成第 3、4、5 条 + 场景 2、5、6 |
| AC8 回归 | 集成第 6 条 |
