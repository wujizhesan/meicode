import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseSkillFile, SkillManager } from '../src/skill/index.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void): Promise<void> {
  try {
    test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function captureWarnings<T>(run: () => T): { result: T; warnings: string[] } {
  const original = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try { return { result: run(), warnings } }
  finally { console.warn = original }
}

const root = mkdtempSync(join(import.meta.dirname, 'fixtures_skill_config_'))
const dirs = { builtin: join(root, 'builtin'), user: join(root, 'user'), project: join(root, 'project') }
for (const directory of Object.values(dirs)) mkdirSync(directory)
const raw = (fields: string) => `---\n${fields}\n---\nSkill 正文 {{task}}\n`
const base = 'name: valid\ndescription: 有效配置'

try {
  const invalidFields = [
    ['名称数字', 'name: 42\ndescription: desc', 'name'],
    ['名称空白', 'name: " "\ndescription: desc', 'name'],
    ['说明布尔值', 'name: valid\ndescription: true', 'description'],
    ['工具数字', `${base}\ntools: 42`, 'tools'],
    ['工具字符串', `${base}\ntools: read_file`, 'tools'],
    ['工具混合数组', `${base}\ntools:\n  - read_file\n  - 42`, 'tools'],
    ['工具空名称', `${base}\ntools: [" "]`, 'tools'],
    ['工具 null', `${base}\ntools: null`, 'tools'],
    ['未知模式', `${base}\nmode: unknown`, 'mode'],
    ['历史负数', `${base}\nhistory: -1`, 'history'],
    ['历史字符串', `${base}\nhistory: "5"`, 'history'],
    ['历史小数', `${base}\nhistory: 1.5`, 'history'],
    ['历史过大整数', `${base}\nhistory: 9007199254740992`, 'history'],
    ['历史 null', `${base}\nhistory: null`, 'history'],
    ['模型数组', `${base}\nmodel: [model]`, 'model'],
    ['模型空字符串', `${base}\nmodel: ""`, 'model'],
    ['根配置数字', '42', 'frontmatter'],
    ['根配置数组', '[one, two]', 'frontmatter'],
  ]
  for (const [name, fields, field] of invalidFields) {
    await check(`配置拒绝${name}并指出字段与文件`, () => {
      const file = join(root, 'invalid.md')
      writeFileSync(file, raw(fields))
      const { result, warnings } = captureWarnings(() => parseSkillFile(file, 'project'))
      assert.equal(result, null)
      assert.equal(warnings.length, 1)
      assert(warnings[0].includes(field))
      assert(warnings[0].includes(file))
    })
  }

  await check('合法零历史、空工具数组与模型字段保留', () => {
    const file = join(root, 'valid.md')
    writeFileSync(file, raw(`${base}\nmode: isolated\nhistory: 0\ntools: []\nmodel: model`))
    const { result, warnings } = captureWarnings(() => parseSkillFile(file, 'project'))
    assert.deepEqual(result, { name: 'valid', description: '有效配置', mode: 'isolated', history: 0, tools: [], model: 'model', content: 'Skill 正文 {{task}}', source: 'project' })
    assert.deepEqual(warnings, [])
  })

  await check('省略可选字段保持共享模式与默认历史', () => {
    const file = join(root, 'defaults.md')
    writeFileSync(file, raw(base))
    const { result, warnings } = captureWarnings(() => parseSkillFile(file, 'builtin'))
    assert.equal(result?.mode, 'shared')
    assert.equal(result?.history, undefined)
    assert.equal(result?.tools, undefined)
    assert.equal(result?.model, undefined)
    assert.deepEqual(warnings, [])
  })

  await check('单个错误 Skill 不阻止有效 Skill 加载，缓存错误也不再抛异常', () => {
    writeFileSync(join(dirs.project, 'broken.md'), raw('name: broken\ndescription: broken\ntools: 42'))
    writeFileSync(join(dirs.project, 'good.md'), raw(`${base}\ntools: [read_file]`))
    const manager = new SkillManager(dirs)
    const { result, warnings } = captureWarnings(() => manager.loadAll())
    assert.deepEqual(result.ok, ['valid'])
    assert.equal(warnings.length, 1)
    assert.equal(manager.get('broken'), undefined)
    assert.deepEqual(manager.get('valid')?.tools, ['read_file'])
    assert.deepEqual(captureWarnings(() => manager.loadAll()).result.ok, ['valid'])
    writeFileSync(join(dirs.project, 'broken.md'), raw('name: broken\ndescription: fixed\ntools: [read_file]'))
    assert.deepEqual(manager.loadAll().ok.sort(), ['broken', 'valid'])
  })

  await check('无效项目覆盖配置保留合法内置同名 Skill', () => {
    writeFileSync(join(dirs.builtin, 'fallback.md'), raw('name: fallback\ndescription: builtin\ntools: [read_file]'))
    writeFileSync(join(dirs.project, 'fallback.md'), raw('name: fallback\ndescription: invalid\nhistory: -1'))
    const manager = new SkillManager(dirs)
    captureWarnings(() => manager.loadAll())
    assert.equal(manager.get('fallback')?.source, 'builtin')
    assert.deepEqual(manager.get('fallback')?.tools, ['read_file'])
  })
  await check('共享 Skill 的空、未配置与非空白名单可区分，独立 Skill 不参与主会话限制', () => {
    writeFileSync(join(dirs.project, 'empty.md'), raw('name: empty\ndescription: empty\ntools: []'))
    writeFileSync(join(dirs.project, 'unrestricted.md'), raw('name: unrestricted\ndescription: unrestricted'))
    writeFileSync(join(dirs.project, 'isolated.md'), raw('name: isolated\ndescription: isolated\nmode: isolated\ntools: [write_file]'))
    const manager = new SkillManager(dirs)
    captureWarnings(() => manager.loadAll())
    manager.activate('unrestricted')
    assert.equal(manager.activeToolNames(), null)
    manager.activate('empty')
    assert.deepEqual(manager.activeToolNames(), [])
    manager.activate('isolated')
    assert.deepEqual(manager.activeToolNames(), [])
    assert(!manager.activePrompt().includes('已激活 Skill: isolated'))
    manager.activate('valid')
    assert.deepEqual(manager.activeToolNames(), ['read_file'])
    manager.deactivate('valid')
    manager.deactivate('empty')
    assert.equal(manager.activeToolNames(), null)
    manager.deactivate('unrestricted')
    assert.equal(manager.activePrompt(), '')
    assert.equal(manager.activeToolNames(), null)
    assert(manager.isActive('isolated'))
  })
  await check('独立任务按激活顺序排队、去重并使用最新参数，停用与清空取消待执行任务', () => {
    for (const name of ['queue-a', 'queue-b']) {
      writeFileSync(join(dirs.project, `${name}.md`), raw(`name: ${name}\ndescription: queue\nmode: isolated\ntools: []`))
    }
    const manager = new SkillManager(dirs)
    captureWarnings(() => manager.loadAll())
    manager.activate('queue-a', { task: '旧参数' })
    manager.activate('queue-b')
    manager.activate('queue-a', { task: '最新参数' })
    manager.activate('unrestricted')
    const first = manager.takeNextIsolated()
    assert.equal(first?.name, 'queue-a')
    assert.equal(first?.content, 'Skill 正文 最新参数')
    assert.deepEqual(first?.tools, [])
    assert.equal(manager.takeNextIsolated()?.name, 'queue-b')
    assert.equal(manager.takeNextIsolated(), undefined)
    manager.activate('queue-a')
    manager.activate('queue-b')
    manager.deactivate('queue-a')
    assert.equal(manager.takeNextIsolated()?.name, 'queue-b')
    assert.equal(manager.takeNextIsolated(), undefined)
    manager.activate('queue-a')
    manager.clearPendingIsolated()
    assert(manager.isActive('queue-a'))
    assert.equal(manager.takeNextIsolated(), undefined)
    manager.activate('queue-b')
    manager.clear()
    assert(!manager.isActive('queue-a'))
    assert(!manager.isActive('queue-b'))
    assert.equal(manager.takeNextIsolated(), undefined)
    assert.equal(manager.lastActivated, null)
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_skill_config_'))
  const verify = (directory: string) => {
    assert(!lstatSync(directory).isSymbolicLink())
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) verify(join(directory, entry.name))
    }
  }
  verify(target)
  rmSync(target, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
