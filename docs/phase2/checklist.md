# MewCode Phase2 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。

## 实现完整性

- [ ] 六工具已实现且可直调（验证：smoke 直调测试，合法参数返回预期结果）
- [ ] 注册中心登记六工具并转 OpenAI 格式（验证：toOpenAITools 输出 name/description/parameters 齐全）
- [ ] edit_file 唯一匹配规则（验证：恰 1 处替换成功；0 处/≥2 处返回带位置的结构化错误）
- [ ] run_command 确认与超时（验证：拒绝不执行；超时 kill 返回超时错误）
- [ ] OpenAI tool_calls 分片聚合（验证：fake SSE 三帧分片聚合出完整参数；解析失败返回结构化错误）

## 集成

- [ ] 单轮循环完整链路（验证：fake provider 两轮 → history 含 user/assistant(tool_calls)/tool/assistant 四段，tool 消息内容为工具结果）
- [ ] 第二轮再调工具被截断（验证：fake provider 两轮都出 tool_call → 提示「暂不支持连环调用」且不执行）
- [ ] 命令确认弹窗（验证：TTY 下 pendingConfirm 渲染「⚠ 执行命令」行，Enter 执行 / Esc 拒绝）
- [ ] 未登记工具名（验证：fake tool_call 用不存在名字 → 「未找到工具」结构化结果回灌，不崩溃）
- [ ] Phase1 纯对话回归（验证：不带 tools 时行为与 Phase1 一致，npm test 旧用例全绿）

## 编译与测试

- [ ] `npx tsc --noEmit` exit 0
- [ ] `npm test` 0 failed（Phase1 + Phase2 全部用例）

## 端到端场景（真实 DeepSeek V4 Flash，`npm start` 交互验证）

- [ ] 场景 1 · 读文件：提问「读一下 D:\MewCode\package.json」→ 模型调 read_file → 最终回复展示文件内容 → 屏幕上可见工具调用过程
- [ ] 场景 2 · 改文件：让模型把 config.example.yaml 里某行旧文本改成新文本（唯一匹配场景）→ 回复确认后文件内容实际已变更
- [ ] 场景 3 · 命令确认：让模型执行 `echo hello` → 出现「⚠ 执行命令」确认行 → Enter 执行后回复体现输出
- [ ] 场景 4 · 命令拒绝：再让模型执行命令 → Esc 拒绝 → 回复体现「用户拒绝」
- [ ] 场景 5 · 失败回灌：让模型「读一下 D:\不存在的文件.txt」→ 结构化错误回灌 → 最终回复能描述错误，不崩溃
- [ ] 场景 6 · 搜索：让模型「找一下 src 下所有 .ts 文件」→ find_files 结果回灌 → 回复列出文件

## 验收标准对照

| spec AC | checklist 条目 |
|---------|---------------|
| AC1 六工具登记+格式 | 实现完整性第 1、2 条 |
| AC2 工具直调成败 | 实现完整性第 1 条 + 集成第 4 条 |
| AC3 DeepSeek 联调读文件 | 端到端场景 1 |
| AC4 流式分片聚合 | 实现完整性第 5 条 |
| AC5 edit_file 匹配规则 | 实现完整性第 3 条 + 端到端场景 2 |
| AC6 run_command 确认/拒绝/超时 | 实现完整性第 4 条 + 场景 3、4 |
| AC7 失败回灌不崩 | 集成第 1 条 + 场景 5 |
