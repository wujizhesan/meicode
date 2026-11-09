import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalPattern } from '../src/agent/tool-execution.ts'
import { checkPermission, RuleEngine } from '../src/permission/index.ts'
import { browserTool } from '../src/tools/browser.ts'
import { browserTool as lazyBrowserTool } from '../src/tools/low_frequency.ts'
import { resolveBrowserShotPath } from '../src/tools/browser_path.ts'
import type { ToolContext } from '../src/tools/types.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-browser-shot-'))
const worktree = join(root, 'worktree')
const outside = join(root, 'outside')
mkdirSync(worktree)
mkdirSync(outside)

try {
  const ctx: ToolContext = { cwd: worktree, rootLock: worktree }
  const controller = new AbortController()
  controller.abort()
  for (const tool of [browserTool, lazyBrowserTool]) {
    const cancelled = await tool.execute({ action: 'shot', path: 'inside.png' }, { ...ctx, signal: controller.signal })
    assert.equal(cancelled.success, false)
    assert.match(cancelled.error ?? '', /取消/)
  }
  const inFlight = new AbortController()
  const pending = lazyBrowserTool.execute({ action: 'shot', path: 'inside.png' }, { ...ctx, signal: inFlight.signal })
  inFlight.abort()
  const interrupted = await pending
  assert.equal(interrupted.success, false)
  assert.match(interrupted.error ?? '', /取消/)

  const outsidePath = join(outside, 'shot.png')
  assert.equal(resolveBrowserShotPath({ path: 'inside.png' }, worktree), join(worktree, 'inside.png'))

  const escaped = await browserTool.execute({ action: 'shot', path: outsidePath }, ctx)
  assert.equal(escaped.success, false)
  assert.match(escaped.error ?? '', /路径越界/)

  const relativeEscape = await browserTool.execute({ action: 'shot', path: '../outside/shot.png' }, ctx)
  assert.equal(relativeEscape.success, false)
  assert.match(relativeEscape.error ?? '', /路径越界/)

  const inside = await browserTool.execute({ action: 'shot', path: 'inside.png' }, ctx)
  assert.equal(inside.success, false)
  assert.match(inside.error ?? '', /浏览器未启动/)

  const extra = await browserTool.execute(
    { action: 'shot', path: outsidePath },
    { ...ctx, rootLockExtra: [outside] },
  )
  assert.equal(extra.success, false)
  assert.match(extra.error ?? '', /浏览器未启动/)

  const missing = await browserTool.execute({ action: 'shot' }, ctx)
  assert.equal(missing.success, false)
  assert.match(missing.error ?? '', /缺少 path/)

  const engine = new RuleEngine('', '', '')
  const shot = { name: 'browser', args: { action: 'shot', path: outsidePath } }
  const unattended = { cwd: worktree, mode: 'unattended' as const, engine }
  assert.equal((await checkPermission(shot, unattended)).type, 'deny')
  assert.equal((await checkPermission(shot, { ...unattended, mode: 'default' })).type, 'ask')
  assert.equal((await checkPermission(
    { name: 'browser', args: { action: 'shot', path: 'inside.png' } }, unattended,
  )).type, 'allow')
  assert.equal((await checkPermission(
    { name: 'browser', args: { action: 'navigate', url: 'about:blank', path: outsidePath } }, unattended,
  )).type, 'allow')
  assert.equal((await checkPermission(shot, { ...unattended, allowedWritePaths: [outside] })).type, 'allow')

  const launchArgs = { action: 'launch' }
  engine.addSessionRule({ tool: 'browser', pattern: approvalPattern('browser', launchArgs), action: 'allow' })
  assert.equal(engine.match({ name: 'browser', args: launchArgs })?.action, 'allow')
  assert.equal(engine.match(shot), null)

  const oldEngine = new RuleEngine('', '', '')
  oldEngine.addSessionRule({ tool: 'browser', pattern: '*', action: 'allow' })
  assert.equal((await checkPermission(shot, { ...unattended, engine: oldEngine })).type, 'deny')

  engine.addSessionRule({ tool: 'browser', pattern: approvalPattern('browser', shot.args), action: 'allow' })
  assert.equal((await checkPermission(shot, { ...unattended, engine, mode: 'default' })).type, 'allow')
  assert.equal(engine.match({ name: 'browser', args: { action: 'shot', path: join(outside, 'other.png') } }), null)

  console.log('browser_shot_test passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
