import { A2aMessageIndex } from '../src/a2a/message-index.ts'
import type { A2ATask } from '../src/a2a/types.ts'

function task(id: string, messageIds: string[]): A2ATask {
  return {
    id,
    contextId: `context-${id}`,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(0).toISOString() },
    history: messageIds.map((messageId) => ({ messageId, role: 'ROLE_USER', parts: [{ kind: 'text', text: messageId }] })),
    artifacts: [],
  }
}

const index = new A2aMessageIndex()
const first = task('first', ['shared', 'first-only'])
const second = task('second', ['shared', 'second-only'])
const third = task('third', ['shared'])
index.addTask(first)
index.addTask(second)
index.addTask(second)
index.addTask(third)

if (index.taskIdFor('shared') !== 'first') throw new Error('重复 messageId 未保持首个任务语义')
if (index.taskIdFor('second-only') !== 'second') throw new Error('任务消息未建立索引')
index.removeTaskIds('unrelated', ['shared', 'first-only'])
if (index.taskIdFor('shared') !== 'first' || index.taskIdFor('first-only') !== 'first') throw new Error('删除无关任务误删了消息索引')

index.removeTask(first)
if (index.taskIdFor('shared') !== 'second') throw new Error('首个任务删除后未回退到剩余任务')
if (index.taskIdFor('first-only') !== undefined) throw new Error('已删除任务仍残留索引')
index.removeTask(second)
if (index.taskIdFor('shared') !== 'third') throw new Error('重复 messageId 缩减后未保留剩余任务')
if (index.taskIdFor('second-only') !== undefined) throw new Error('第二个任务删除后仍残留索引')
index.removeTask(third)
if (index.taskIdFor('shared') !== undefined) throw new Error('最后一个任务删除后仍残留共享索引')

index.addMessage('third', { messageId: 'third-only' })
if (index.taskIdFor('third-only') !== 'third') throw new Error('增量消息未写入索引')

console.log('a2a_message_index_test passed')
