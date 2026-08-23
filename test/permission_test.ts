// 权限系统测试：黑名单/沙箱/规则/优先级/模式/人在回路
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPermission, RuleEngine, matchBlacklist, isPathAllowed } from '../src/permission/index.ts'
import type { PermissionMode, Rule, ToolCallInfo } from '../src/permission/types.ts'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

const TMP = join(import.meta.dirname, 'fixtures_perm')
const OUTSIDE = join(import.meta.dirname, 'fixtures_perm_outside')
mkdirSync(TMP, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(TMP, 'inside.txt'), 'in', 'utf8')
writeFileSync(join(OUTSIDE, 'secret.txt'), 'secret', 'utf8')
// 符号链接逃逸：cwd 内 link 指向外部
try {
  symlinkSync(join(OUTSIDE, 'secret.txt'), join(TMP, 'escape_link.txt'))
} catch {
  // Windows 无权限创建符号链接时跳过该用例
}

function makeEngine(projectRules: Rule[] = [], mode?: PermissionMode): RuleEngine {
  // 每用例前清理残留规则文件，防状态泄漏
  rmSync(join(TMP, 'local_rules.yaml'), { force: true })
  rmSync(join(TMP, 'user_rules.yaml'), { force: true })
  const projectFile = join(TMP, 'rules.yaml')
  if (projectRules.length > 0 || mode) {
    const shape: Record<string, unknown> = {}
    if (mode) shape.mode = mode
    if (projectRules.length > 0) {
      shape.rules = projectRules.map((r) => ({ tool: r.tool, pattern: r.pattern, action: r.action }))
    }
    writeFileSync(projectFile, JSON.stringify(shape), 'utf8')
  } else {
    rmSync(projectFile, { force: true })
  }
  const engine = new RuleEngine(join(TMP, 'user_rules.yaml'), projectFile, join(TMP, 'local_rules.yaml'))
  engine.loadAll()
  return engine
}

function call(name: string, args: Record<string, unknown>): ToolCallInfo {
  return { name, args }
}

async function main() {
  // ---------- 黑名单 ----------
  await check('黑名单: 高危命令命中', () => {
    for (const cmd of ['rm -rf /', 'rm -rf / ', 'del /s /q C:\\Windows\\temp', 'format c:', 'diskpart', 'reg delete HKLM\\x']) {
      if (!matchBlacklist(cmd).matched) throw new Error(`未拦截: ${cmd}`)
    }
  })
  await check('黑名单: 正常命令放行', () => {
    for (const cmd of ['git status', 'node -v', 'dir', 'npm install', 'ping 127.0.0.1']) {
      if (matchBlacklist(cmd).matched) throw new Error(`误拦: ${cmd}`)
    }
  })

  // ---------- 危险命令警告表(16 类) ----------
  await check('警告表: 危险命令命中 → default 弹窗带文案', async () => {
    const engine = new RuleEngine('', '', '')
    for (const cmd of ['git push --force origin main', 'git reset --hard HEAD~1', 'rm -rf node_modules', 'kubectl delete pod x', 'terraform destroy']) {
      const d = await checkPermission({ name: 'run_command', args: { command: cmd } }, { cwd: TMP, mode: 'default', engine, autoAcceptEdits: true })
      if (d.type !== 'ask' || !d.reason?.startsWith('[危险命令')) throw new Error(`未警告: ${cmd} => ${d.type}`)
    }
  })
  await check('警告表: strict 直接拒绝', async () => {
    const engine = new RuleEngine('', '', '')
    const d = await checkPermission({ name: 'run_command', args: { command: 'git push --force' } }, { cwd: TMP, mode: 'strict', engine, autoAcceptEdits: true })
    if (d.type !== 'deny') throw new Error(`strict 未拒绝: ${d.type}`)
  })
  await check('警告表: 批准后免确认 + deny 规则优先', async () => {
    const engine = new RuleEngine('', '', '')
    engine.addSessionRule({ tool: 'run_command', pattern: 'git push --force', action: 'allow' })
    const d1 = await checkPermission({ name: 'run_command', args: { command: 'git push --force' } }, { cwd: TMP, mode: 'default', engine, autoAcceptEdits: true })
    if (d1.type !== 'allow') throw new Error(`批准后未放行: ${d1.type}`)
    engine.addSessionRule({ tool: 'run_command', pattern: 'rm -rf *', action: 'deny' })
    const d2 = await checkPermission({ name: 'run_command', args: { command: 'rm -rf *' } }, { cwd: TMP, mode: 'default', engine, autoAcceptEdits: true })
    if (d2.type !== 'deny') throw new Error(`deny 未优先: ${d2.type}`)
  })

  // ---------- 沙箱 ----------
  await check('沙箱: cwd 内允许', async () => {
    if (!(await isPathAllowed(join(TMP, 'inside.txt'), TMP))) throw new Error('cwd 内被拒')
    if (!(await isPathAllowed('inside.txt', TMP))) throw new Error('相对路径被拒')
    if (!(await isPathAllowed(join(TMP, 'not_exist/deep/file.txt'), TMP))) throw new Error('深层不存在路径被误伤')
  })
  await check('沙箱: 外部绝对路径拒绝', async () => {
    if (await isPathAllowed(join(OUTSIDE, 'secret.txt'), TMP)) throw new Error('外部路径未拒绝')
  })
  await check('沙箱: 符号链接逃逸拒绝', async () => {
    const link = join(TMP, 'escape_link.txt')
    if (!existsSync(link)) return // 无权限创建链接的环境跳过
    if (await isPathAllowed(link, TMP)) throw new Error('符号链接逃逸未被拦截')
  })

  // ---------- 规则引擎 ----------
  await check('规则: git * allow 匹配与 deny 拦截', async () => {
    const engine = makeEngine([{ tool: 'run_command', pattern: 'git *', action: 'allow', source: 'project' }])
    const r = engine.match(call('run_command', { command: 'git status' }))
    if (!r || r.action !== 'allow') throw new Error('git status 未放行')
    if (engine.match(call('run_command', { command: 'npm install' }))) throw new Error('npm 被误匹配')
  })
  await check('规则: deny 优先于 allow（同层）', async () => {
    const engine = makeEngine([
      { tool: 'run_command', pattern: 'git *', action: 'allow', source: 'project' },
      { tool: 'run_command', pattern: 'git push *', action: 'deny', source: 'project' },
    ])
    const r = engine.match(call('run_command', { command: 'git push origin main' }))
    if (!r || r.action !== 'deny') throw new Error('deny 未优先')
    const r2 = engine.match(call('run_command', { command: 'git status' }))
    if (!r2 || r2.action !== 'allow') throw new Error('git status 应 allow')
  })
  await check('规则: 本地级盖过项目级', async () => {
    const projectFile = join(TMP, 'rules.yaml')
    writeFileSync(projectFile, JSON.stringify({ rules: [{ tool: 'run_command', pattern: 'git *', action: 'allow' }] }), 'utf8')
    const localFile = join(TMP, 'local_rules.yaml')
    writeFileSync(localFile, JSON.stringify({ rules: [{ tool: 'run_command', pattern: 'git *', action: 'deny' }] }), 'utf8')
    const engine = new RuleEngine(join(TMP, 'user_rules.yaml'), projectFile, localFile)
    engine.loadAll()
    const r = engine.match(call('run_command', { command: 'git status' }))
    if (!r || r.action !== 'deny' || r.source !== 'local') throw new Error(`本地级未盖过项目级: ${JSON.stringify(r)}`)
  })
  await check('规则: 会话级盖过本地级', async () => {
    const engine = makeEngine()
    engine.addSessionRule({ tool: 'run_command', pattern: 'git *', action: 'deny' })
    const localFile = join(TMP, 'local_rules.yaml')
    writeFileSync(localFile, JSON.stringify({ rules: [{ tool: 'run_command', pattern: 'git *', action: 'allow' }] }), 'utf8')
    engine.loadAll()
    const r = engine.match(call('run_command', { command: 'git status' }))
    if (!r || r.action !== 'deny' || r.source !== 'session') throw new Error(`会话级未生效: ${JSON.stringify(r)}`)
  })
  await check('规则: appendProjectRule 写入文件后生效', async () => {
    const engine = makeEngine()
    engine.appendProjectRule({ tool: 'read_file', pattern: 'src/**', action: 'allow' })
    const projectFile = join(TMP, 'rules.yaml')
    if (!existsSync(projectFile)) throw new Error('项目规则文件未创建')
    const content = readFileSync(projectFile, 'utf8')
    if (!content.includes('src/**')) throw new Error('规则未写入文件')
    const engine2 = new RuleEngine(join(TMP, 'user_rules.yaml'), projectFile, join(TMP, 'local_rules.yaml'))
    engine2.loadAll()
    const r = engine2.match(call('read_file', { path: 'src/index.ts' }))
    if (!r || r.action !== 'allow') throw new Error('重载后规则未生效')
  })

  // ---------- 裁决链 ----------
  await check('裁决: 黑名单优先（permissive 也拦截）', async () => {
    const d = await checkPermission(call('run_command', { command: 'rm -rf /' }), {
      cwd: TMP,
      mode: 'permissive',
      engine: makeEngine(),
    })
    if (d.type !== 'deny' || !d.reason.includes('黑名单')) throw new Error(`黑名单未拦截: ${JSON.stringify(d)}`)
  })
  await check('裁决: 沙箱越界拒绝、规则 allow 放开', async () => {
    const d1 = await checkPermission(call('read_file', { path: join(OUTSIDE, 'secret.txt') }), {
      cwd: TMP,
      mode: 'default',
      engine: makeEngine(),
    })
    if (d1.type !== 'ask') throw new Error(`沙箱越界应 ask: ${JSON.stringify(d1)}`)
    const d2 = await checkPermission(call('read_file', { path: join(OUTSIDE, 'secret.txt') }), {
      cwd: TMP,
      mode: 'default',
      engine: makeEngine([{ tool: 'read_file', pattern: join(OUTSIDE, '**'), action: 'allow', source: 'project' }]),
    })
    if (d2.type !== 'allow') throw new Error(`规则应放开沙箱: ${JSON.stringify(d2)}`)
  })
  await check('裁决: strict 白名单制', async () => {
    const d = await checkPermission(call('run_command', { command: 'git status' }), {
      cwd: TMP,
      mode: 'strict',
      engine: makeEngine(),
    })
    if (d.type !== 'deny' || !d.reason.includes('strict')) throw new Error(`strict 应拒: ${JSON.stringify(d)}`)
    const d2 = await checkPermission(call('run_command', { command: 'git status' }), {
      cwd: TMP,
      mode: 'strict',
      engine: makeEngine([{ tool: 'run_command', pattern: 'git *', action: 'allow', source: 'project' }]),
    })
    if (d2.type !== 'allow') throw new Error('strict 下规则 allow 应放行')
  })
  await check('裁决: default 未命中 ask、permissive 放行', async () => {
    // npm install 为写命令,不在只读豁免内
    const d1 = await checkPermission(call('run_command', { command: 'npm install' }), {
      cwd: TMP,
      mode: 'default',
      engine: makeEngine(),
    })
    if (d1.type !== 'ask') throw new Error(`default 应 ask: ${JSON.stringify(d1)}`)
    const d2 = await checkPermission(call('run_command', { command: 'npm install' }), {
      cwd: TMP,
      mode: 'permissive',
      engine: makeEngine(),
    })
    if (d2.type !== 'allow') throw new Error(`permissive 应放行: ${JSON.stringify(d2)}`)
  })
  await check('裁决: 规则 deny 直接拒绝不弹窗', async () => {
    const d = await checkPermission(call('run_command', { command: 'git push origin main' }), {
      cwd: TMP,
      mode: 'default',
      engine: makeEngine([{ tool: 'run_command', pattern: 'git push *', action: 'deny', source: 'project' }]),
    })
    if (d.type !== 'deny' || !d.reason.includes('规则拒绝')) throw new Error(`规则 deny 应直接拒: ${JSON.stringify(d)}`)
  })

  await check('权限: 只读命令不允许链式操作', async () => {
    const engine = new RuleEngine('', '', '')
    for (const command of ['git status && del /s /q C:\\Windows\\temp', 'dir & echo chained', 'git log | findstr secret']) {
      const decision = await checkPermission(call('run_command', { command }), { cwd: TMP, mode: 'default', engine })
      if (decision.type === 'allow') throw new Error(`链式命令被错误放行: ${command}`)
    }
  })

  await check('规则: loadAll 幂等且不重复加载', () => {
    const projectFile = join(TMP, 'rules-idempotent.yaml')
    writeFileSync(projectFile, JSON.stringify({ rules: [{ tool: 'read_file', pattern: 'src/**', action: 'allow' }] }), 'utf8')
    const engine = new RuleEngine('', projectFile, '')
    engine.loadAll()
    const first = (engine as unknown as { rulesBySource: { project: Rule[] } }).rulesBySource.project.length
    engine.loadAll()
    const second = (engine as unknown as { rulesBySource: { project: Rule[] } }).rulesBySource.project.length
    if (first !== 1 || second !== 1) throw new Error(`规则重复加载: ${first} -> ${second}`)
  })

  await check('规则: 非对象配置可安全追加', () => {
    const projectFile = join(TMP, 'rules-invalid.yaml')
    writeFileSync(projectFile, '[]', 'utf8')
    const engine = new RuleEngine('', projectFile, '')
    engine.appendProjectRule({ tool: 'read_file', pattern: 'src/**', action: 'allow' })
    const reloaded = new RuleEngine('', projectFile, '')
    reloaded.loadAll()
    if (!reloaded.match(call('read_file', { path: 'src/index.ts' }))) throw new Error('坏配置追加后规则未生效')
  })

  rmSync(TMP, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('permission 测试异常:', e)
  process.exit(1)
})
