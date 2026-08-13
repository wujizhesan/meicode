// 四模式映射测试：default / edits / plan / yolo
import { resolveMode, MODE_LABEL } from '../src/tui/mode.ts'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

check('default: full + default 权限 + 不豁免编辑', () => {
  const c = resolveMode('default')
  if (c.agentMode !== 'full' || c.permMode !== 'default' || c.autoEdits !== false) throw new Error(JSON.stringify(c))
})

check('edits: full + default 权限 + 豁免编辑', () => {
  const c = resolveMode('edits')
  if (c.agentMode !== 'full' || c.permMode !== 'default' || c.autoEdits !== true) throw new Error(JSON.stringify(c))
})

check('plan: 只读工具 + default 权限', () => {
  const c = resolveMode('plan')
  if (c.agentMode !== 'plan' || c.permMode !== 'default' || c.autoEdits !== false) throw new Error(JSON.stringify(c))
})

check('yolo: full + permissive 权限', () => {
  const c = resolveMode('yolo')
  if (c.agentMode !== 'full' || c.permMode !== 'permissive' || c.autoEdits !== false) throw new Error(JSON.stringify(c))
})

check('标签完整', () => {
  for (const m of ['default', 'edits', 'plan', 'yolo'] as const) {
    if (!MODE_LABEL[m]) throw new Error(`缺标签: ${m}`)
  }
})

// 与权限裁决的联动：edits 豁免 write_file/edit_file、run_command 仍 ask
import { checkPermission, RuleEngine } from '../src/permission/index.ts'

check('联动: edits 模式下 write_file 未命中规则自动放行', async () => {
  const engine = new RuleEngine('', '', '')
  const d = await checkPermission({ name: 'write_file', args: { path: 'x.txt' } }, {
    cwd: process.cwd(),
    mode: 'default',
    engine,
    autoAcceptEdits: true,
  })
  if (d.type !== 'allow') throw new Error(`应放行: ${JSON.stringify(d)}`)
})

check('联动: edits 模式下 run_command 未命中仍 ask', async () => {
  const engine = new RuleEngine('', '', '')
  const d = await checkPermission({ name: 'run_command', args: { command: 'echo hi' } }, {
    cwd: process.cwd(),
    mode: 'default',
    engine,
    autoAcceptEdits: true,
  })
  if (d.type !== 'ask') throw new Error(`应 ask: ${JSON.stringify(d)}`)
})

check('联动: edits 模式下规则 deny 仍拦截', async () => {
  const engine = new RuleEngine('', '', '')
  engine.addSessionRule({ tool: 'write_file', pattern: '*', action: 'deny' })
  const d = await checkPermission({ name: 'write_file', args: { path: 'x.txt' } }, {
    cwd: process.cwd(),
    mode: 'default',
    engine,
    autoAcceptEdits: true,
  })
  if (d.type !== 'deny') throw new Error(`规则 deny 应拦截: ${JSON.stringify(d)}`)
})

check('联动: yolo 下黑名单仍拦截', async () => {
  const engine = new RuleEngine('', '', '')
  const d = await checkPermission({ name: 'run_command', args: { command: 'rm -rf /' } }, {
    cwd: process.cwd(),
    mode: 'permissive',
    engine,
  })
  if (d.type !== 'deny' || !d.reason.includes('黑名单')) throw new Error(`黑名单应拦截: ${JSON.stringify(d)}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
