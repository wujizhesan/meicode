import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, delimiter, resolve } from 'node:path'
import { cleanFixtures } from './clean-fixtures.mjs'
import { SLOW_TESTS } from './test-tiers.mjs'

const root = resolve(import.meta.dirname, '..')
const testDir = join(root, 'test')

// 测试进程的 git 围栏：夹具仓库建在 test/ 下，一旦 `git init` 失败（磁盘满、权限、
// git 缺失等），git 会向上找到 MeiCode 主仓库，把 worktree 注册和 wt-* 分支
// 静默写进主仓库（实测主仓库被注入过 11 个 worktree + 11 个分支，且会让下次运行
// 因 "a branch named 'wt-xxx' already exists" 直接失败）。
// 把 root 设为 ceiling 后，git 在 test/ 内永远解析不到主仓库，失败会显式报错。
const testEnv = {
  ...process.env,
  GIT_CEILING_DIRECTORIES: [root, process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(delimiter),
}
const allTests = readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && (entry.name === 'smoke.ts' || /_(?:test|smoke)\.tsx?$/.test(entry.name)))
  .map((entry) => entry.name)
  .sort()

// 分层：本地高频回归用 --tier fast 跳过慢测试，CI 不带参数即跑全量。
// 判定依据是上一次运行的实测耗时（test/.timings.json），而不是写死的清单——
// 静态清单既会随代码变化腐坏，也容易漏掉"上次超时失败所以没记录耗时"的文件。
// 没有耗时记录时回退到 scripts/test-tiers.mjs 的人工清单。
const timingsFile = join(testDir, '.timings.json')

// 每个文件保留最近若干次实测耗时（而不是单个值）。单值缓存无论取「上一次」还是
// 「历史极值」都会被一次异常运行钉死，只有窗口能跟着代码/机器的变化漂移。
const TIMING_WINDOW = 5

function readTimings() {
  try {
    const parsed = JSON.parse(readFileSync(timingsFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized = {}
    for (const [name, value] of Object.entries(parsed)) {
      // 兼容旧格式：早期版本每个文件只存一个数字
      const samples = (Array.isArray(value) ? value : [value])
        .map(Number)
        .filter((ms) => Number.isFinite(ms) && ms > 0)
      if (samples.length > 0) normalized[name] = samples.slice(-TIMING_WINDOW)
    }
    return normalized
  } catch {
    return {}
  }
}

// 取中位数，不用最小值也不用最大值：
// - 最小值只降不升：一旦某次机器空闲跑出 400ms，这个测试即使后来退化到 8s，
//   也会因为「历史最小 400ms」永远留在 fast 层，分层永久失真。
// - 最大值/上一次则相反：一次本机病态就把一堆正常测试误判成慢测试，
//   实测病态一次后 fast 从 113 个掉到 60 个。
// 中位数在窗口内滑动，最多 TIMING_WINDOW 次运行就会反映真实状态，且对单次极值不敏感。
function median(samples) {
  if (!samples || samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const hi = sorted[mid]
  if (sorted.length % 2 === 1) return hi
  return Math.round((sorted[mid - 1] + hi) / 2)
}

// 默认 5s 而不是 20s：并发跑出来的单文件耗时普遍被压低（4 worker 下中位只有 1.3s），
// 20s 阈值实际只过滤掉 1 个文件，--tier fast 会退化成全量，分层名存实亡。
const slowMs = Math.max(1000, Number(process.env.MEICODE_SLOW_MS) || 5000)
const timings = readTimings()
const isSlow = (name) => {
  const measured = median(timings[name])
  if (measured > 0) return measured >= slowMs
  return SLOW_TESTS.has(name)
}

// `--exclude <子串>` / `--filter <子串>` 用于临时圈定范围
function argValues(flag) {
  const values = []
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1])
  }
  return values
}
const tier = (argValues('--tier')[0] ?? process.env.MEICODE_TEST_TIER ?? 'all').toLowerCase()
const excludes = argValues('--exclude')
const filters = argValues('--filter')
if (!['all', 'fast'].includes(tier)) {
  process.stderr.write(`未知的 --tier: ${tier}（可选 all | fast）\n`)
  process.exit(1)
}
const tests = allTests.filter((name) => {
  if (tier === 'fast' && isSlow(name)) return false
  if (filters.length > 0 && !filters.some((value) => name.includes(value))) return false
  return !excludes.some((value) => name.includes(value))
})
if (tests.length === 0) {
  process.stderr.write('没有匹配的测试文件\n')
  process.exit(1)
}
if (process.argv.includes('--list')) {
  process.stdout.write(`${tests.join('\n')}\n`)
  process.exit(0)
}

const workersArgIndex = process.argv.indexOf('--workers')
const configuredWorkers = Number(workersArgIndex >= 0 ? process.argv[workersArgIndex + 1] : process.env.MEICODE_TEST_WORKERS)
const workers = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? Math.min(configuredWorkers, 8)
  : Math.min(4, availableParallelism())
const timeoutMs = Math.max(1000, Number(process.env.MEICODE_TEST_TIMEOUT_MS) || 120000)
let cursor = 0
const failures = []
const results = []
const startedAt = Date.now()

function runTest(file) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--import', 'tsx', join(testDir, file)], {
      cwd: root,
      env: testEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveRun({ file, code: -1, stdout, stderr: `${stderr}${error.message}\n`, durationMs: Date.now() - started, timedOut })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveRun({ file, code: code ?? -1, stdout, stderr, durationMs: Date.now() - started, timedOut })
    })
  })
}

async function worker() {
  while (true) {
    const index = cursor++
    if (index >= tests.length) return
    const result = await runTest(tests[index])
    results.push(result)
    if (result.code === 0 && !result.timedOut) {
      process.stdout.write(`  ✓ ${result.file} (${result.durationMs}ms)\n`)
    } else {
      failures.push(result)
      process.stderr.write(`  ✗ ${result.file} (${result.timedOut ? 'timeout' : `exit ${result.code}`})\n`)
    }
  }
}

const skipped = allTests.length - tests.length
// 并发下的墙钟近似等于「单文件耗时之和 / worker 数」，打印出来才能让"fast 到底快多少"可验证
const basis = tier === 'fast'
  ? `（跳过 ${skipped} 个 ≥${slowMs}ms 的，保留部分预计墙钟 ≈${Math.round(tests.reduce((sum, name) => sum + median(timings[name]), 0) / workers / 1000)}s）`
  : ''
process.stdout.write(`并行测试: ${tests.length} 个文件，${workers} 个 worker${skipped > 0 ? `（tier=${tier}${basis}）` : ''}\n`)
await Promise.all(Array.from({ length: workers }, () => worker()))

// 回写本文件耗时，供下次 --tier fast 判定；失败/超时的文件同样记录
// （它们的耗时同样真实，而且正是最该被本地迭代跳过的一批）
//
// 追加进滑动窗口而不是覆盖单个值：窗口取中位数，既能容忍单次机器抖动，
// 又保证测试真的变慢/变快后，最多 TIMING_WINDOW 次运行内被重新归类。
const nextTimings = { ...timings }
for (const result of results) {
  const previous = nextTimings[result.file] ?? []
  nextTimings[result.file] = [...previous, result.durationMs].slice(-TIMING_WINDOW)
}
try {
  writeFileSync(timingsFile, `${JSON.stringify(nextTimings, null, 2)}\n`)
} catch {
  // 耗时缓存写不进去不影响测试结论
}

// 先输出结果与失败详情：夹具回收可能受慢磁盘拖累，不能挡在诊断信息前面
for (const failure of failures) {
  process.stderr.write(`\n--- ${failure.file} stdout ---\n${failure.stdout}`)
  process.stderr.write(`\n--- ${failure.file} stderr ---\n${failure.stderr}`)
}

const durationMs = Date.now() - startedAt
if (failures.length > 0) {
  process.stderr.write(`\n测试失败: ${failures.length}/${tests.length}，耗时 ${(durationMs / 1000).toFixed(1)}s\n`)
} else {
  process.stdout.write(`测试通过: ${tests.length}/${tests.length}，耗时 ${(durationMs / 1000).toFixed(1)}s\n`)
}

// 回收本轮与历史遗留的测试产物：夹具目录，以及指向夹具的陈旧 worktree 注册
const { dirs: cleanedDirs, worktrees: cleanedWorktrees } = cleanFixtures()
if (cleanedDirs.length > 0 || cleanedWorktrees.length > 0) {
  process.stdout.write(`回收测试夹具: ${cleanedDirs.length} 个目录，${cleanedWorktrees.length} 个 worktree 注册\n`)
}

process.exit(failures.length > 0 ? 1 : 0)
