import { A2aFilterIndex } from '../src/a2a/filter-index.ts'
import type { A2aTaskMetadata } from '../src/a2a/store.ts'
import type { TaskState } from '../src/a2a/types.ts'

const index = new A2aFilterIndex()
const expected = new Map<string, A2aTaskMetadata>()
const contexts = ['context-a', 'context-b', 'context-c']
const states: TaskState[] = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED']

const verify = (contextId?: string, state?: TaskState): void => {
  const ids = [...expected.values()]
    .filter((metadata) => (!contextId || metadata.contextId === contextId) && (!state || metadata.state === state))
    .map((metadata) => metadata.id)
    .sort()
  if (index.ids(contextId, state).join(',') !== ids.join(',')) throw new Error(`筛选索引结果错误: ${contextId ?? '*'} / ${state ?? '*'}`)
}

for (let step = 0; step < 500; step++) {
  const id = `task-${(step * 37) % 53}`
  const previous = expected.get(id)
  if (step % 11 === 0) {
    if (previous) index.delete(previous)
    expected.delete(id)
  } else {
    const metadata: A2aTaskMetadata = {
      id,
      contextId: contexts[step % contexts.length],
      state: states[(step * 3) % states.length],
      timestamp: new Date(step * 1000).toISOString(),
      messageIds: [],
      pendingPushDeliveries: 0,
    }
    index.upsert(metadata, previous)
    expected.set(id, metadata)
  }
  verify(contexts[step % contexts.length])
  verify(undefined, states[step % states.length])
  verify(contexts[(step + 1) % contexts.length], states[(step + 2) % states.length])
  verify('missing-context')
}

for (const metadata of expected.values()) index.delete(metadata)
if (index.ids('context-a').length || index.ids(undefined, 'TASK_STATE_COMPLETED').length) throw new Error('删除后筛选索引仍保留任务')

console.log('a2a_filter_index_test passed')
