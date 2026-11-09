// unified diff 的单元用例：只锁「行号正确、标记正确、规模可控」这几件事
import { unifiedDiff } from '../src/tools/diff.ts'

let passed = 0
let failed = 0

function check(name: string, test: () => void): void {
  try {
    test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}: ${(error as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

check('完全相同返回空串', () => {
  assert(unifiedDiff('a\nb\n', 'a\nb\n') === '', '相同内容不应产生 diff')
})

check('单行替换：标记与行号正确', () => {
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n')
  const lines = diff.split('\n')
  assert(lines[0].startsWith('@@ -1,'), `hunk 头应以 -1 开头: ${lines[0]}`)
  assert(lines.includes('-b'), '缺少删除行 -b')
  assert(lines.includes('+B'), '缺少新增行 +B')
  assert(lines.includes(' a') && lines.includes(' c'), '缺少上下文行')
})

check('前缀改动时行号随之偏移', () => {
  const before = `${'x\n'.repeat(10)}old\n`
  const after = `${'x\n'.repeat(10)}new\n`
  const diff = unifiedDiff(before, after)
  // 第 11 行发生变化，hunk 头里应当是 -8 起（3 行上下文）
  assert(diff.startsWith('@@ -8,4 +8,4 @@'), `hunk 头不符: ${diff.split('\n')[0]}`)
})

check('新增文件：全为 + 行', () => {
  const diff = unifiedDiff('', 'a\nb')
  assert(diff.includes('+a') && diff.includes('+b'), '新增行标记缺失')
  assert(!diff.includes('-a'), '不应出现删除行')
})

check('超过行数上限会截断并标注', () => {
  const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
  const after = Array.from({ length: 400 }, (_, i) => `LINE ${i}`).join('\n')
  const diff = unifiedDiff(before, after, { maxLines: 20 })
  assert(diff.split('\n').length <= 22, `未按上限截断: ${diff.split('\n').length} 行`)
  assert(diff.includes('diff 已截断'), '缺少截断标注')
})

check('超大输入退化为整段替换且不抛错', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n')
  const other = Array.from({ length: 2000 }, (_, i) => `m${i}`).join('\n')
  const diff = unifiedDiff(big, other, { maxLines: 50 })
  assert(diff.length > 0, '应产生 diff')
  assert(diff.includes('diff 已截断'), '大输入未截断')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
