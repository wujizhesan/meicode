---
name: commit
description: 提交 git 变更（生成或使用提交信息）
tools: [run_command, read_file]
mode: shared
---

# Commit Skill

按以下步骤提交 git 变更：

1. 运行 `git status` 查看变更文件
2. 运行 `git diff --stat` 了解改动范围
3. 确定提交信息：用户提供了则使用「{{message}}」，否则根据改动内容生成简洁的 Conventional Commits 信息
4. 运行 `git add -A` 暂存全部变更
5. 运行 `git commit -m "<提交信息>"` 提交
6. 向用户报告：提交哈希、提交信息、变更文件数

注意事项：
- Windows 环境，不要使用 head/tail/grep 等 Unix 命令
- 如果 git status 显示不在仓库内，停止并说明
- 命令失败 2 次停止，报告已获取的信息
