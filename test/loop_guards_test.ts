import { nextToolFailureStreak, nextUnknownToolStreak, RepeatedToolCallGuard } from '../src/agent/loop-guards.ts'
import { summarizeRuntimeValue } from '../src/agent/runtime-summary.ts'

const known = (name: string) => name !== 'missing'
if (nextUnknownToolStreak([{ name: 'missing', arguments: {} }], known, 1) !== 2) {
  throw new Error('unknown tool streak did not increment')
}
if (nextUnknownToolStreak([{ name: 'read_file', arguments: {} }], known, 2) !== 0) {
  throw new Error('known tool did not reset unknown streak')
}
if (nextToolFailureStreak([false, false], 2) !== 3) throw new Error('failure streak did not increment')
if (nextToolFailureStreak([false, true], 2) !== 0) throw new Error('successful tool did not reset failure streak')

const repeated = new RepeatedToolCallGuard()
const call = { name: 'write_file', arguments: { path: 'same.txt', content: 'x' } }
for (let i = 0; i < 4; i++) {
  if (repeated.inspect([call], known, (item) => JSON.stringify(item.arguments))) {
    throw new Error(`repeat guard stopped too early at ${i + 1}`)
  }
}
const stopped = repeated.inspect([call], known, (item) => JSON.stringify(item.arguments))
if (stopped?.name !== 'write_file' || stopped.count !== 5) throw new Error('repeat guard did not stop at threshold')

const exempt = new RepeatedToolCallGuard(6, 2)
for (let i = 0; i < 10; i++) {
  const result = exempt.inspect([{ name: 'read_file', arguments: { path: 'same.txt' } }], known, (item) => JSON.stringify(item.arguments))
  if (result) throw new Error('read-only tool should be exempt from repeat guard')
}

const long = summarizeRuntimeValue('x'.repeat(700))
if (!long.truncated || typeof long.value !== 'string' || long.value.length > 550) throw new Error('long runtime value was not compacted')
const nested = summarizeRuntimeValue({ a: { b: { c: { d: true } } } })
if (!nested.truncated || JSON.stringify(nested.value).includes('"d":true')) throw new Error('nested runtime value was not bounded')

console.log('loop_guards_test passed')
