---
name: review
description: 审查最近的 git 变更（diff 分析，问题与建议）
tools: [run_command, read_file]
mode: shared
---

# Review Skill

审查最近的 git 变更：

1. 运行 `git status` 看仓库状态
2. 运行 `git diff` 看未提交变更；若为空运行 `git log --oneline -5` 看最近提交
3. 分析改动：逻辑错误、边界情况、安全问题、可维护性
4. 输出：按严重程度排序的问题列表 + 改进建议

注意事项：
- Windows 环境：没有 head/tail/grep/less，禁止使用；只用 git 原生命令
- 不要编造 git 参数
- 最多执行 4 个命令；命令失败 2 次停止，报告已获取的信息
- 非 git 仓库立即停止并说明
