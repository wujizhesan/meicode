// 夹具 git 围栏（side-effect import）。
//
// 供直接运行单个测试文件时使用：`node --import tsx test/worktree_test.ts`。
// 经 scripts/test.mjs 运行时，runner 已经设了同样的环境变量，这里重复设置无副作用。
//
// 背景：夹具仓库建在 test/ 下。若 `git init` 失败（磁盘、权限、git 不可用等），
// git 会继续向上搜索并找到 MeiCode 主仓库，于是 `git worktree add -b wt-xxx`
// 会把 worktree 注册和 wt-* 分支**静默写进主仓库**（实测被注入过 11 个 worktree
// 注册 + 11 个分支，还会让下次运行因 "a branch named 'wt-xxx' already exists" 直接失败）。
//
// 把主仓库根目录设为 ceiling 后，git 在 test/ 内永远解析不到主仓库：
// 夹具仓库自己仍能被正常发现（它就在 cwd 或其上级），但一旦 init 失败，
// 得到的是显式的 "not a git repository" 报错，而不是静默污染主仓库。
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const delimiter = process.platform === 'win32' ? ';' : ':'
process.env.GIT_CEILING_DIRECTORIES = [repoRoot, process.env.GIT_CEILING_DIRECTORIES]
  .filter(Boolean)
  .join(delimiter)
