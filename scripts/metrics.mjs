// 项目指标统计：node scripts/metrics.mjs
//
// 存在的意义：文档里的规模数字（README / INTERVIEW）曾经与代码树严重脱节——
// 写着「35 个测试文件」，实际已经是 160+。人工维护的数字一定会腐烂，
// 所以这里把口径写成代码，任何人在任何时间都能重新算一遍并对照文档。
//
// 口径说明（改口径请同步改本文件顶部的注释与 docs 中的说明）：
//   - 源码        src/ 下全部 .ts / .tsx
//   - 测试入口    与 scripts/test.mjs 相同的筛选：smoke.ts 或 *_(test|smoke).tsx?
//   - 具名用例    自定义 check('名字', fn) 骨架里的命名子用例
//   - 断言        assert. 调用点（脚本式测试文件直接 throw 断言，不计入）
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function walk(dir, accept) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, accept))
    else if (entry.isFile() && accept(entry.name)) out.push(full)
  }
  return out
}

// 与 `wc -l` 口径一致（数换行符），方便和命令行交叉核对
const countLines = (text) => (text.match(/\n/g) ?? []).length + (text.endsWith('\n') || text === '' ? 0 : 1)
const lineCount = (files) => files.reduce((sum, f) => sum + countLines(readFileSync(f, 'utf8')), 0)
const countIn = (files, re) => files.reduce((sum, f) => sum + (readFileSync(f, 'utf8').match(re) ?? []).length, 0)

// —— 源码 ——
const srcFiles = walk(join(root, 'src'), (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
const srcLines = lineCount(srcFiles)

// —— 测试 ——
const isTestEntry = (name) => name === 'smoke.ts' || /_(?:test|smoke)\.tsx?$/.test(name)
const testFiles = walk(join(root, 'test'), isTestEntry)
const testLines = lineCount(testFiles)
// 具名子用例：check('...', ...)；排除 `function check(` 定义本身
const namedCases = countIn(testFiles, /(?:^|[^A-Za-z0-9_.])check\(/gm)
const assertions = countIn(testFiles, /assert\./g)
const nodeTestFiles = testFiles.filter((f) => /from 'node:test'/.test(readFileSync(f, 'utf8'))).length

// —— 其它 ——
const roles = walk(join(root, 'src', 'agents'), (n) => n.endsWith('.md'))
const docsFiles = walk(join(root, 'docs'), () => true)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const deps = Object.keys(pkg.dependencies ?? {}).length
const devDeps = Object.keys(pkg.devDependencies ?? {}).length

const rows = [
  ['版本', `v${pkg.version}`],
  ['源码', `${srcFiles.length} 个文件 / ${srcLines.toLocaleString('en-US')} 行`],
  ['测试入口', `${testFiles.length} 个文件 / ${testLines.toLocaleString('en-US')} 行`],
  ['测试 : 源码（行）', `${(testLines / srcLines).toFixed(2)} : 1`],
  ['具名用例', `${namedCases.toLocaleString('en-US')} 个（check 骨架）`],
  ['断言', `${assertions.toLocaleString('en-US')} 处`],
  ['node:test 依赖', nodeTestFiles === 0 ? '无（自带轻量骨架）' : `${nodeTestFiles} 个文件`],
  ['内置角色', `${roles.length} 个`],
  ['设计文档', `${docsFiles.length} 个文件 / ${lineCount(docsFiles).toLocaleString('en-US')} 行`],
  ['依赖', `${deps} 个运行时 / ${devDeps} 个开发`],
]

const width = Math.max(...rows.map(([k]) => [...k].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0)))
console.log('\nMeiCode 项目指标\n' + '─'.repeat(46))
for (const [k, v] of rows) {
  const pad = width - [...k].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0)
  console.log(`${k}${' '.repeat(pad)}  ${v}`)
}
console.log()
