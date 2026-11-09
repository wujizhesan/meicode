import { A2aExpiryIndex } from '../src/a2a/expiry-index.ts'

const index = new A2aExpiryIndex()
const expected = new Map<string, number>()

const nextDue = (): number | undefined => expected.size > 0 ? Math.min(...expected.values()) : undefined

for (let step = 0; step < 1_000; step++) {
  const id = `task-${(step * 37) % 73}`
  if (step % 7 === 0) {
    index.delete(id)
    expected.delete(id)
  } else {
    const at = (step * 31) % 101
    index.set(id, at)
    expected.set(id, at)
  }
  const expectedAt = nextDue()
  const head = index.peek()
  if (head?.at !== expectedAt || (head && expected.get(head.id) !== head.at)) throw new Error(`到期索引最早任务错误: ${step}`)
  if (step % 11 === 0 && expectedAt !== undefined) {
    const popped = index.pop()
    if (popped?.at !== expectedAt || expected.get(popped.id) !== popped.at) throw new Error(`到期索引弹出顺序错误: ${step}`)
    expected.delete(popped.id)
  }
}

while (expected.size > 0) {
  const due = nextDue()!
  const popped = index.pop()
  if (popped?.at !== due || expected.get(popped.id) !== popped.at) throw new Error('到期索引批量弹出顺序错误')
  expected.delete(popped.id)
}
if (index.pop() || index.peek()) throw new Error('到期索引没有清空')

console.log('a2a_expiry_index_test passed')
