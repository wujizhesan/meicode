import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { TeamManager } from '../src/team/index.ts'
import { TeamMail } from '../src/team/mail.ts'
import { bounded, streamFixture } from './stream-fixture.ts'

let passed = 0, failed = 0
async function check(name: string, test: (root: string) => Promise<void>) {
  if (process.argv[2] && !name.includes(process.argv[2])) return
  const root = fs.mkdtempSync(join(import.meta.dirname, 'fixtures_mail_registry_'))
  try { await test(root); passed++; console.log('  ✓ ' + name) }
  catch (error) { failed++; console.error('  ✗ ' + name, error) }
  finally {
    const target = resolve(root)
    assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_mail_registry_'))
    const verify = (dir: string) => {
      assert(!fs.lstatSync(dir).isSymbolicLink())
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink())
        if (entry.isDirectory()) verify(join(dir, entry.name))
      }
    }
    verify(target)
    fs.rmSync(target, { recursive: true, force: true })
  }
}
const backups = (root: string) => fs.readdirSync(root).filter((file) => file.includes('.corrupt.'))

for (const state of ['fresh', 'cached']) {
  for (const code of ['EIO', 'EACCES', 'EBUSY']) {
    await check(`注册表 ${state} ${code} 读取失败保留健康文件和原身份`, async (root) => {
      const initial = new TeamMail(root)
      initial.register('Alice')
      const mail = state === 'fresh' ? new TeamMail(root) : initial
      const file = join(root, 'registry.json'), before = fs.readFileSync(file)
      if (state === 'cached') fs.utimesSync(file, new Date(), new Date(Date.now() + 1000))
      const original = fs.readFileSync
      fs.readFileSync = ((path, options) => {
        if (String(path) === file) throw Object.assign(new Error(`REGISTRY-${code}`), { code })
        return original(path, options)
      }) as typeof fs.readFileSync
      syncBuiltinESMExports()
      try {
        assert.throws(() => mail.register('Bob'), /无法读取邮箱注册表/)
        assert(fs.existsSync(file))
        assert(original(file).equals(before))
        assert.deepEqual(backups(root), [])
      } finally { fs.readFileSync = original; syncBuiltinESMExports() }
      mail.register('Bob')
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['Alice', 'Bob'])
      assert.throws(() => new TeamMail(root).register('alice'), /大小写冲突/)
    })
  }
}

await check('注册表 stat 失败不写入、不隔离，恢复后正常追加', async (root) => {
  const mail = new TeamMail(root)
  mail.register('Alice')
  const file = join(root, 'registry.json'), before = fs.readFileSync(file), original = fs.statSync
  fs.statSync = ((path, options) => {
    if (String(path) === file) throw Object.assign(new Error('REGISTRY-STAT-EIO'), { code: 'EIO' })
    return original(path, options)
  }) as typeof fs.statSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => mail.register('Bob'), /无法读取邮箱注册表/)
    assert(fs.readFileSync(file).equals(before))
    assert.deepEqual(backups(root), [])
  } finally { fs.statSync = original; syncBuiltinESMExports() }
  mail.register('Bob')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['Alice', 'Bob'])
})

await check('单个非法注册名明确失败且不创建目录外文件', async (root) => {
  const mail = new TeamMail(join(root, 'mail'))
  assert.throws(() => mail.register('../outside'), /非法邮箱注册名/)
  assert.deepEqual(fs.readdirSync(root), [])
})

await check('批量注册返回每个非法名字的失败，合法名字仍正常登记', async (root) => {
  const mail = new TeamMail(root)
  const result = mail.registerMany(['Alice', '../outside', '', 'Bob', 'Alice'])
  assert.deepEqual([...result.registered], ['Alice', 'Bob'])
  assert.deepEqual([...result.failures.keys()], ['../outside', ''])
  assert([...result.failures.values()].every((error) => error.message.includes('非法邮箱注册名')))
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(join(root, 'registry.json'), 'utf8'))), ['Alice', 'Bob'])
})

await check('真实损坏注册表仍隔离原始内容并拒绝覆盖', async (root) => {
  const cases = ['{"Alice":', '[]', '{"../outside":"box"}', '{"Alice":"box","alice":"box"}']
  for (let index = 0; index < cases.length; index++) {
    const dir = join(root, String(index))
    fs.mkdirSync(dir)
    const file = join(dir, 'registry.json'), content = cases[index]
    fs.writeFileSync(file, content)
    assert.throws(() => new TeamMail(dir).register('Bob'), /邮箱注册表损坏/)
    assert.equal(fs.existsSync(file), false)
    assert.equal(backups(dir).length, 1)
    assert.equal(fs.readFileSync(join(dir, backups(dir)[0]), 'utf8'), content)
  }
})

await check('隔离损坏文件失败时保留原文件，错误不谎报已隔离', async (root) => {
  const file = join(root, 'registry.json'), content = '{BROKEN', original = fs.renameSync
  fs.writeFileSync(file, content)
  fs.renameSync = ((source, destination) => {
    if (String(source) === file) throw Object.assign(new Error('QUARANTINE-EACCES'), { code: 'EACCES' })
    return original(source, destination)
  }) as typeof fs.renameSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => new TeamMail(root).register('Bob'), (error: unknown) => {
      assert(error instanceof Error)
      assert.match(error.message, /邮箱注册表损坏/)
      assert.match(error.message, /隔离失败/)
      assert.match(error.message, /QUARANTINE-EACCES/)
      assert(!error.message.includes('隔离到'))
      return true
    })
    assert.equal(fs.readFileSync(file, 'utf8'), content)
    assert.deepEqual(backups(root), [])
  } finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.throws(() => new TeamMail(root).register('Bob'), /邮箱注册表损坏/)
  assert.equal(backups(root).length, 1)
})

await check('团队恢复时注册表读取故障不丢已有邮箱，恢复后真实任务只执行一次', async () => {
  let models = 0, effects = 0
  const provider: Provider = { protocol: 'openai', async *streamChat() {
    if (++models === 1) yield { type: 'tool_call', id: 'effect', name: 'write_file', arguments: {} }
    else { yield { type: 'text', text: 'REGISTRY-RECOVERED' }; yield { type: 'done' } }
  } }
  const f = await streamFixture(provider), teamRoot = join(f.root, 'team')
  const opts = { provider, registry: f.registry, ctx: { ...f.chat.getToolContext(), agentId: 'lead-agent' } }
  const team = new TeamManager(teamRoot, f.root, opts), fresh = new TeamManager(teamRoot, f.root, opts)
  const original = fs.readFileSync
  try {
    const group = team.createGroup('audit', 'lead')
    await team.spawnMember(group, 'Alice', 'worker', { agentId: 'alice-agent', roleDefinition: null })
    const mailRoot = join(teamRoot, '_shared', 'mail'), mail = new TeamMail(mailRoot)
    mail.register('Outside')
    mail.send('Outside', 'Alice', 'EXISTING-MAIL')
    const file = join(mailRoot, 'registry.json'), before = fs.readFileSync(file)
    await team.close(1000)
    fs.readFileSync = ((path, options) => {
      if (String(path) === file) throw Object.assign(new Error('RESTORE-REGISTRY-EIO'), { code: 'EIO' })
      return original(path, options)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    assert.deepEqual(await fresh.restore([]), [])
    assert(original(file).equals(before))
    assert.deepEqual(backups(mailRoot), [])
    assert.equal(models, 0)
    fs.readFileSync = original; syncBuiltinESMExports()
    assert.deepEqual(await fresh.restore([]), ['audit/Alice'])
    assert.equal(mail.read('Alice')[0].body, 'EXISTING-MAIL')
    assert.throws(() => mail.register('outside'), /大小写冲突/)
    const effectFile = join(f.root, 'effect.log')
    f.registry.register({ name: 'write_file', description: '回归真实写入', parameters: { type: 'object' }, async execute() {
      effects++; fs.appendFileSync(effectFile, 'EFFECT\n'); return { success: true, output: 'SAVED' }
    } })
    const task = fresh.addTask('audit', 'REGISTRY-RECOVERY', 'Alice')
    await bounded(fresh.runTask(fresh.loadGroup('audit')!, task, 'Alice'))
    assert.equal(fresh.listTasks('audit')[0].status, 'done')
    assert.equal(models, 2)
    assert.equal(effects, 1)
    assert.equal(fs.readFileSync(effectFile, 'utf8'), 'EFFECT\n')
  } finally {
    fs.readFileSync = original; syncBuiltinESMExports()
    await team.close(1000); await fresh.close(1000); await f.close()
  }
})

for (const type of ['APPROVE', 'DENY', 'PROTO', 'PLAN', 'ASSIGN', 'IDLE'] as const) {
  await check(`${type} 协议保留同行正文和后续原始换行`, async () => {
    assert.deepEqual(TeamMail.parseProtocol(`${type}  第一行\r\n第二行`), { type, rest: '第一行\r\n第二行' })
  })
}

await check('普通文本前缀不能误识别成协议', async () => {
  for (const body of ['APPROVED 可以', 'DENYING', 'PROTOCOL data', 'PLANNER', 'ASSIGNMENT', 'IDLENESS', 'PLAN-THING', 'PLAN_1']) {
    assert.deepEqual(TeamMail.parseProtocol(body), { type: 'TEXT', rest: body })
  }
})

await check('协议大小写、前导空白和冒号分隔不丢正文', async () => {
  const body = '\t approve :\t理由\r\n第二行'
  assert.deepEqual(TeamMail.parseProtocol(body), { type: 'APPROVE', rest: '理由\r\n第二行' })
})

await check('兼容 PROTO 冒号和中文冒号形式，保留正文', async () => {
  assert.deepEqual(TeamMail.parseProtocol('PROTO:ping'), { type: 'PROTO', rest: 'ping' })
  assert.deepEqual(TeamMail.parseProtocol('PLAN：先检查\n再执行'), { type: 'PLAN', rest: '先检查\n再执行' })
})

await check('普通文本保持原始内容，协议只能出现在首行', async () => {
  for (const body of ['  普通文本\n原始内容  ', '\nPLAN 第二行', '正文\nAPPROVE 可以']) {
    assert.deepEqual(TeamMail.parseProtocol(body), { type: 'TEXT', rest: body })
  }
})

await check('独立协议首行保留下一行正文的冒号', async () => {
  assert.deepEqual(TeamMail.parseProtocol('PLAN\n: 正文'), { type: 'PLAN', rest: ': 正文' })
  assert.deepEqual(TeamMail.parseProtocol('IDLE'), { type: 'IDLE', rest: '' })
})

console.log(`邮箱登记与协议: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
