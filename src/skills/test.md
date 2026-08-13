---
name: test
description: 运行项目测试并分析失败（独立会话执行，结果摘要回流）
tools: [run_command, read_file]
mode: isolated
history: 5
---

# Test Skill

运行项目测试并分析结果：

1. 运行 `npm test`（或根据 package.json 的 scripts 确定测试命令）
2. 观察输出：通过的用例数、失败的用例数与失败详情
3. 分析失败原因：测试代码问题 vs 业务代码问题
4. 输出结论：测试概况 + 失败用例列表 + 每个失败的初步原因判断

注意事项：
- Windows 环境，不要使用 head/tail/grep 等 Unix 命令
- 测试输出可能很长，关注尾部与失败摘要
- 命令失败 2 次停止，报告已获取的信息
