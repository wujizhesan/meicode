import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { checkPermission, RuleEngine } from '../src/permission/index.ts'
import { approvalPattern } from '../src/agent/tool-execution.ts'
import { shotDiffTool } from '../src/tools/shot_diff.ts'
import { shotDiffTool as lazyShotDiffTool } from '../src/tools/low_frequency.ts'
import type { ToolContext } from '../src/tools/types.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-shot-diff-'))
const worktree = join(root, 'worktree')
const outside = join(root, 'outside')
mkdirSync(worktree)
mkdirSync(outside)

const basePath = join(worktree, 'base.png')
const targetPath = join(worktree, 'target.png')
const outsideTargetPath = join(outside, 'target.png')
const outsideOutputPath = join(outside, 'diff.png')
const insideOutputPath = join(worktree, 'diff.png')
const base = new PNG({ width: 2, height: 2 })
base.data.fill(255)
const target = new PNG({ width: 2, height: 2 })
target.data.fill(255)
target.data[0] = 0
writeFileSync(basePath, PNG.sync.write(base))
writeFileSync(targetPath, PNG.sync.write(target))
writeFileSync(outsideTargetPath, PNG.sync.write(target))

try {
  const ctx: ToolContext = { cwd: worktree, rootLock: worktree }
  const cancelledOut = join(worktree, 'cancelled.png')
  const controller = new AbortController()
  controller.abort()
  for (const tool of [shotDiffTool, lazyShotDiffTool]) {
    const result = await tool.execute(
      { base: basePath, target: targetPath, out: cancelledOut },
      { ...ctx, signal: controller.signal },
    )
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /取消/)
    assert.equal(existsSync(cancelledOut), false)
  }
  for (const tool of [shotDiffTool, lazyShotDiffTool]) {
    const inFlight = new AbortController()
    const pending = tool.execute(
      { base: basePath, target: targetPath, out: cancelledOut },
      { ...ctx, signal: inFlight.signal },
    )
    inFlight.abort()
    const result = await pending
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /取消/)
    assert.equal(existsSync(cancelledOut), false)
  }

  const explicit = await shotDiffTool.execute({ base: basePath, target: targetPath, out: outsideOutputPath }, ctx)
  assert.equal(explicit.success, false)
  assert.match(explicit.error ?? '', /路径越界/)
  assert.equal(existsSync(outsideOutputPath), false)

  const implicit = await shotDiffTool.execute({ base: basePath, target: outsideTargetPath }, ctx)
  assert.equal(implicit.success, false)
  assert.match(implicit.error ?? '', /路径越界/)
  assert.equal(existsSync(`${outsideTargetPath}.diff.png`), false)

  const inside = await shotDiffTool.execute({ base: basePath, target: outsideTargetPath, out: insideOutputPath }, ctx)
  assert.equal(inside.success, true)
  assert.equal(existsSync(insideOutputPath), true)

  const extra = await shotDiffTool.execute(
    { base: basePath, target: targetPath, out: outsideOutputPath },
    { ...ctx, rootLockExtra: [outside] },
  )
  assert.equal(extra.success, true)
  assert.equal(existsSync(outsideOutputPath), true)

  const engine = new RuleEngine('', '', '')
  const permission = { cwd: worktree, mode: 'unattended' as const, engine }
  const outsideExplicit = await checkPermission(
    { name: 'shot_diff', args: { base: basePath, target: targetPath, out: outsideOutputPath } },
    permission,
  )
  assert.equal(outsideExplicit.type, 'deny')

  const outsideImplicit = await checkPermission(
    { name: 'shot_diff', args: { base: basePath, target: outsideTargetPath } },
    permission,
  )
  assert.equal(outsideImplicit.type, 'deny')

  const insideExplicit = await checkPermission(
    { name: 'shot_diff', args: { base: basePath, target: outsideTargetPath, out: insideOutputPath } },
    permission,
  )
  assert.equal(insideExplicit.type, 'allow')

  const allowedExtra = await checkPermission(
    { name: 'shot_diff', args: { base: basePath, target: targetPath, out: outsideOutputPath } },
    { ...permission, allowedWritePaths: [outside] },
  )
  assert.equal(allowedExtra.type, 'allow')

  const approvedArgs = { base: basePath, target: targetPath, out: outsideOutputPath }
  engine.addSessionRule({ tool: 'shot_diff', pattern: approvalPattern('shot_diff', approvedArgs), action: 'allow' })
  assert.equal(engine.match({ name: 'shot_diff', args: approvedArgs })?.action, 'allow')
  assert.equal(engine.match({ name: 'shot_diff', args: { ...approvedArgs, out: join(outside, 'another.png') } }), null)

  const defaultArgs = { base: basePath, target: outsideTargetPath }
  engine.addSessionRule({ tool: 'shot_diff', pattern: approvalPattern('shot_diff', defaultArgs), action: 'allow' })
  assert.equal(engine.match({ name: 'shot_diff', args: defaultArgs })?.action, 'allow')
  assert.equal(engine.match({ name: 'shot_diff', args: { base: basePath, target: targetPath } }), null)

  console.log('shot_diff_test passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
