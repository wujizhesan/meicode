import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const testDir = join(root, 'test')
const tests = readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && (entry.name === 'smoke.ts' || /_(?:test|smoke)\.tsx?$/.test(entry.name)))
  .map((entry) => entry.name)
  .sort()
const workersArgIndex = process.argv.indexOf('--workers')
const configuredWorkers = Number(workersArgIndex >= 0 ? process.argv[workersArgIndex + 1] : process.env.MEICODE_TEST_WORKERS)
const workers = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? Math.min(configuredWorkers, 8)
  : Math.min(4, availableParallelism())
const timeoutMs = Math.max(1000, Number(process.env.MEICODE_TEST_TIMEOUT_MS) || 120000)
let cursor = 0
const failures = []
const startedAt = Date.now()

function runTest(file) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--import', 'tsx', join(testDir, file)], {
      cwd: root,
      env: process.env,
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
    if (result.code === 0 && !result.timedOut) {
      process.stdout.write(`  ✓ ${result.file} (${result.durationMs}ms)\n`)
    } else {
      failures.push(result)
      process.stderr.write(`  ✗ ${result.file} (${result.timedOut ? 'timeout' : `exit ${result.code}`})\n`)
    }
  }
}

process.stdout.write(`并行测试: ${tests.length} 个文件，${workers} 个 worker\n`)
await Promise.all(Array.from({ length: workers }, () => worker()))

for (const failure of failures) {
  process.stderr.write(`\n--- ${failure.file} stdout ---\n${failure.stdout}`)
  process.stderr.write(`\n--- ${failure.file} stderr ---\n${failure.stderr}`)
}

const durationMs = Date.now() - startedAt
if (failures.length > 0) {
  process.stderr.write(`\n测试失败: ${failures.length}/${tests.length}，耗时 ${(durationMs / 1000).toFixed(1)}s\n`)
  process.exit(1)
}
process.stdout.write(`测试通过: ${tests.length}/${tests.length}，耗时 ${(durationMs / 1000).toFixed(1)}s\n`)
