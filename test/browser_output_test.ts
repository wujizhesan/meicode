import assert from 'node:assert/strict'
import { formatBrowserEvalResult } from '../src/tools/browser.ts'
import { MAX_RESULT_BYTES } from '../src/tools/types.ts'

const largeText = '中😀'.repeat(3000)
for (const value of [largeText, { text: largeText }]) {
  const result = formatBrowserEvalResult(value)
  assert.equal(result.success, true)
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= MAX_RESULT_BYTES)
  assert.ok(result.output.endsWith('…[结果已截断]'))
  assert.equal(result.output.includes('�'), false)
}

assert.deepEqual(formatBrowserEvalResult({ message: '你好😀' }), {
  success: true,
  output: '{"message":"你好😀"}',
  truncated: false,
})
assert.equal(formatBrowserEvalResult('').output, '(空结果)')
assert.equal(formatBrowserEvalResult(undefined).output, 'undefined')
assert.equal(formatBrowserEvalResult(123n).output, '123')

console.log('browser_output_test passed')
