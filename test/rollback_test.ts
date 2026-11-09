import './git-ceiling.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { rollbackTool, snapshotTool } from '../src/tools/snapshot.ts'
import { rollbackTool as lazyRollbackTool, snapshotTool as lazySnapshotTool } from '../src/tools/low_frequency.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-rollback-test-'))
// 目录守卫放在创建处：若留在 finally 里抛错，会遮蔽真正的断言失败原因
const guardedRoot = realpathSync(root)
const guardedTemp = realpathSync(tmpdir())
if (!basename(guardedRoot).startsWith('meicode-rollback-test-') || !guardedRoot.startsWith(guardedTemp + sep)) {
  throw new Error('临时目录校验失败')
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function setup(name: string, options: { oldFile?: boolean; newFile?: boolean } = {}): string {
  const cwd = join(root, name)
  mkdirSync(cwd)
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.name', 'Rollback Test')
  git(cwd, 'config', 'user.email', 'rollback@example.invalid')
  // 夹具仓库不能受开发者/CI 的全局 git 配置影响：Windows runner 上 core.autocrlf
  // 会把检出的 LF 变成 CRLF，使按字节比较文件内容的断言（'v1\n'）失败。
  git(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(cwd, 'sample.txt'), 'v1\n')
  git(cwd, 'add', 'sample.txt')
  if (options.oldFile) {
    writeFileSync(join(cwd, 'old.txt'), 'snapshot\n')
    git(cwd, 'add', 'old.txt')
  }
  git(cwd, 'commit', '-qm', 'first')
  git(cwd, 'tag', 'snap-old')
  writeFileSync(join(cwd, 'sample.txt'), 'v2\n')
  git(cwd, 'add', 'sample.txt')
  if (options.oldFile) git(cwd, 'rm', 'old.txt')
  if (options.newFile) {
    writeFileSync(join(cwd, 'new.txt'), 'anchor\n')
    git(cwd, 'add', 'new.txt')
  }
  git(cwd, 'commit', '-qm', 'second')
  return cwd
}

try {
  const cancelledCwd = setup('cancelled')
  writeFileSync(join(cancelledCwd, 'sample.txt'), 'pending\n')
  const cancelledHead = git(cancelledCwd, 'rev-parse', 'HEAD')
  const cancelledStatus = git(cancelledCwd, 'status', '--porcelain')
  const cancelledTags = git(cancelledCwd, 'tag', '--list')
  const controller = new AbortController()
  controller.abort()
  for (const tool of [snapshotTool, lazySnapshotTool]) {
    const result = await tool.execute({ label: 'should-not-commit' }, { cwd: cancelledCwd, signal: controller.signal })
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /取消/)
    assert.equal(git(cancelledCwd, 'rev-parse', 'HEAD'), cancelledHead)
    assert.equal(git(cancelledCwd, 'status', '--porcelain'), cancelledStatus)
    assert.equal(git(cancelledCwd, 'tag', '--list'), cancelledTags)
  }
  for (const tool of [rollbackTool, lazyRollbackTool]) {
    const result = await tool.execute({ tag: 'snap-old', action: 'stage' }, { cwd: cancelledCwd, signal: controller.signal })
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /取消/)
    assert.equal(git(cancelledCwd, 'rev-parse', 'HEAD'), cancelledHead)
    assert.equal(git(cancelledCwd, 'status', '--porcelain'), cancelledStatus)
    assert.equal(readFileSync(join(cancelledCwd, 'sample.txt'), 'utf8'), 'pending\n')
    assert.equal(existsSync(join(cancelledCwd, '.meicode', 'rollback-state.json')), false)
  }
  for (const [tool, args] of [
    [lazySnapshotTool, { label: 'should-not-commit' }],
    [lazyRollbackTool, { tag: 'snap-old', action: 'stage' }],
  ] as const) {
    const inFlight = new AbortController()
    const pending = tool.execute(args, { cwd: cancelledCwd, signal: inFlight.signal })
    inFlight.abort()
    const result = await pending
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /取消/)
    assert.equal(git(cancelledCwd, 'rev-parse', 'HEAD'), cancelledHead)
    assert.equal(git(cancelledCwd, 'status', '--porcelain'), cancelledStatus)
  }
  const normalSnapshot = await snapshotTool.execute({ label: 'normal' }, { cwd: cancelledCwd })
  assert.equal(normalSnapshot.success, true, normalSnapshot.error ?? '')
  assert.notEqual(git(cancelledCwd, 'rev-parse', 'HEAD'), cancelledHead)
  console.log('  ✓ 已取消的快照和回滚不修改 Git 状态，正常快照仍成功')

  const sameClockCwd = setup('same-clock')
  const actualNow = Date.now
  let firstTag = ''
  let secondTag = ''
  try {
    Date.now = () => 1700000000000
    const first = await snapshotTool.execute({ label: 'first' }, { cwd: sameClockCwd })
    assert.equal(first.success, true, first.error ?? '')
    firstTag = first.output.match(/快照 (snap-[a-z0-9-]+)\(/)?.[1] ?? ''
    const firstHead = git(sameClockCwd, 'rev-parse', 'HEAD')
    const second = await snapshotTool.execute({ label: 'second' }, { cwd: sameClockCwd })
    assert.equal(second.success, true, second.error ?? '')
    secondTag = second.output.match(/快照 (snap-[a-z0-9-]+)\(/)?.[1] ?? ''
    assert.notEqual(firstTag, secondTag)
    assert.equal(git(sameClockCwd, 'rev-parse', `refs/tags/${firstTag}^{commit}`), firstHead)
    assert.equal(git(sameClockCwd, 'rev-parse', `refs/tags/${secondTag}^{commit}`), git(sameClockCwd, 'rev-parse', 'HEAD'))
  } finally {
    Date.now = actualNow
  }
  console.log('  ✓ 同一时间值创建的快照使用不同标签')

  const blockedTagCwd = join(root, 'blocked-tag')
  mkdirSync(blockedTagCwd)
  git(blockedTagCwd, 'init', '-q')
  git(blockedTagCwd, 'config', 'user.name', 'Rollback Test')
  git(blockedTagCwd, 'config', 'user.email', 'rollback@example.invalid')
  writeFileSync(join(blockedTagCwd, 'sample.txt'), 'before\n')
  git(blockedTagCwd, 'add', 'sample.txt')
  git(blockedTagCwd, 'commit', '-qm', 'first')
  const blockedTagDir = join(blockedTagCwd, '.git', 'refs', 'tags')
  rmdirSync(blockedTagDir)
  writeFileSync(blockedTagDir, 'blocked')
  const beforeFailedTag = git(blockedTagCwd, 'rev-parse', 'HEAD')
  writeFileSync(join(blockedTagCwd, 'sample.txt'), 'after\n')
  const tagFailure = await snapshotTool.execute({ label: 'tag-failure' }, { cwd: blockedTagCwd })
  const afterFailedTag = git(blockedTagCwd, 'rev-parse', 'HEAD')
  assert.equal(tagFailure.success, false)
  assert.notEqual(afterFailedTag, beforeFailedTag)
  assert.match(tagFailure.error ?? '', /标签 .* 创建失败/)
  assert.ok(tagFailure.error?.includes(afterFailedTag))
  assert.match(tagFailure.error ?? '', /HEAD 已更新/)
  console.log('  ✓ 打标签失败时明确报告已创建的提交与 HEAD 状态')

  const cwd = setup('clear')
  writeFileSync(join(cwd, 'sample.txt'), 'v3-staged\n')
  git(cwd, 'add', 'sample.txt')
  writeFileSync(join(cwd, 'sample.txt'), 'v4-worktree\n')
  writeFileSync(join(cwd, 'untracked.txt'), 'untouched\n')
  const stage = await rollbackTool.execute({ tag: 'snap-old', action: 'stage' }, { cwd })
  assert.equal(stage.success, true, stage.error ?? '')
  assert.equal(readFileSync(join(cwd, 'sample.txt'), 'utf8'), 'v1\n')
  assert.equal(git(cwd, 'show', ':sample.txt'), 'v1')
  const duplicate = await rollbackTool.execute({ tag: 'snap-old', action: 'stage' }, { cwd })
  assert.equal(duplicate.success, false)
  const wrongTag = await rollbackTool.execute({ tag: 'snap-other', action: 'clear' }, { cwd })
  assert.equal(wrongTag.success, false)
  const clear = await rollbackTool.execute({ tag: 'snap-old', action: 'clear' }, { cwd })
  assert.equal(clear.success, true, clear.error ?? '')
  assert.equal(readFileSync(join(cwd, 'sample.txt'), 'utf8'), 'v4-worktree\n')
  assert.equal(git(cwd, 'show', ':sample.txt'), 'v3-staged')
  assert.equal(readFileSync(join(cwd, 'untracked.txt'), 'utf8'), 'untouched\n')
  assert.equal(git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/meicode/rollback'), '')
  assert.equal(existsSync(join(cwd, '.meicode', 'rollback-state.json')), false)
  console.log('  ✓ stage → clear 恢复暂存、未暂存及未跟踪文件')

  const commitCwd = setup('commit')
  writeFileSync(join(commitCwd, 'sample.txt'), 'v3-staged\n')
  git(commitCwd, 'add', 'sample.txt')
  const stageForCommit = await rollbackTool.execute({ tag: 'snap-old', action: 'stage' }, { cwd: commitCwd })
  assert.equal(stageForCommit.success, true, stageForCommit.error ?? '')
  const commit = await rollbackTool.execute({ tag: 'snap-old', action: 'commit' }, { cwd: commitCwd })
  assert.equal(commit.success, true, commit.error ?? '')
  assert.equal(git(commitCwd, 'show', 'HEAD:sample.txt'), 'v1')
  assert.equal(git(commitCwd, 'ls-files', '.meicode'), '')
  assert.equal(git(commitCwd, 'for-each-ref', '--format=%(refname)', 'refs/meicode/rollback'), '')
  assert.equal(existsSync(join(commitCwd, '.meicode', 'rollback-state.json')), false)
  console.log('  ✓ commit 不提交回滚状态文件并清理备份')

  const stageCollisionCwd = setup('stage-collision', { oldFile: true })
  writeFileSync(join(stageCollisionCwd, 'old.txt'), 'untracked-user-content\n')
  const stageCollision = await rollbackTool.execute({ tag: 'snap-old', action: 'stage' }, { cwd: stageCollisionCwd })
  assert.equal(stageCollision.success, false)
  assert.match(stageCollision.error ?? '', /未跟踪文件冲突/)
  assert.equal(readFileSync(join(stageCollisionCwd, 'old.txt'), 'utf8'), 'untracked-user-content\n')
  assert.equal(existsSync(join(stageCollisionCwd, '.meicode', 'rollback-state.json')), false)
  console.log('  ✓ stage 拒绝覆盖同名未跟踪文件')

  const clearCollisionCwd = setup('clear-collision', { newFile: true })
  const collisionStage = await rollbackTool.execute({ tag: 'snap-old', action: 'stage' }, { cwd: clearCollisionCwd })
  assert.equal(collisionStage.success, true, collisionStage.error ?? '')
  writeFileSync(join(clearCollisionCwd, 'new.txt'), 'new-untracked-content\n')
  const clearCollision = await rollbackTool.execute({ tag: 'snap-old', action: 'clear' }, { cwd: clearCollisionCwd })
  assert.equal(clearCollision.success, false)
  assert.match(clearCollision.error ?? '', /未跟踪文件冲突/)
  assert.equal(readFileSync(join(clearCollisionCwd, 'new.txt'), 'utf8'), 'new-untracked-content\n')
  assert.equal(existsSync(join(clearCollisionCwd, '.meicode', 'rollback-state.json')), true)
  rmSync(join(clearCollisionCwd, 'new.txt'))
  const retriedClear = await rollbackTool.execute({ tag: 'snap-old', action: 'clear' }, { cwd: clearCollisionCwd })
  assert.equal(retriedClear.success, true, retriedClear.error ?? '')
  assert.equal(readFileSync(join(clearCollisionCwd, 'new.txt'), 'utf8'), 'anchor\n')
  console.log('  ✓ clear 冲突时保留备份并允许重试')

  const postStageCwd = setup('post-stage-changes')
  writeFileSync(join(postStageCwd, 'sample.txt'), 'v3-staged\n')
  git(postStageCwd, 'add', 'sample.txt')
  writeFileSync(join(postStageCwd, 'sample.txt'), 'v4-worktree\n')
  const postStageStart = await rollbackTool.execute({ tag: 'snap-old', action: 'stage' }, { cwd: postStageCwd })
  assert.equal(postStageStart.success, true, postStageStart.error ?? '')
  writeFileSync(join(postStageCwd, 'sample.txt'), 'new-work-after-stage\n')
  const dirtyWorktree = await rollbackTool.execute({ tag: 'snap-old', action: 'clear' }, { cwd: postStageCwd })
  assert.equal(dirtyWorktree.success, false)
  assert.match(dirtyWorktree.error ?? '', /工作区有 stage 之后的新改动/)
  assert.equal(readFileSync(join(postStageCwd, 'sample.txt'), 'utf8'), 'new-work-after-stage\n')
  assert.equal(existsSync(join(postStageCwd, '.meicode', 'rollback-state.json')), true)
  git(postStageCwd, 'restore', '--source=snap-old', '--worktree', '--', 'sample.txt')
  writeFileSync(join(postStageCwd, 'sample.txt'), 'new-staged-after-stage\n')
  git(postStageCwd, 'add', 'sample.txt')
  const dirtyIndex = await rollbackTool.execute({ tag: 'snap-old', action: 'clear' }, { cwd: postStageCwd })
  assert.equal(dirtyIndex.success, false)
  assert.match(dirtyIndex.error ?? '', /暂存区有 stage 之后的新改动/)
  assert.equal(git(postStageCwd, 'show', ':sample.txt'), 'new-staged-after-stage')
  git(postStageCwd, 'restore', '--source=snap-old', '--staged', '--worktree', '--', 'sample.txt')
  const postStageClear = await rollbackTool.execute({ tag: 'snap-old', action: 'clear' }, { cwd: postStageCwd })
  assert.equal(postStageClear.success, true, postStageClear.error ?? '')
  assert.equal(readFileSync(join(postStageCwd, 'sample.txt'), 'utf8'), 'v4-worktree\n')
  assert.equal(git(postStageCwd, 'show', ':sample.txt'), 'v3-staged')
  console.log('  ✓ clear 拒绝丢弃 stage 后新改动并允许重试')
} finally {
  rmSync(root, { recursive: true, force: true })
}
