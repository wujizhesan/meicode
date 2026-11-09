import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { TeamGroupStore } from '../src/team/group.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-task-cache-'))
if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试目录不在临时目录内')
try {
  const first = new TeamGroupStore(join(root, 'team'))
  const second = new TeamGroupStore(join(root, 'team'))
  first.createGroup('bench', 'lead')
  const input = [
    { id: 'a', title: 'task a', status: 'todo' as const, depends_on: ['b'] },
    { id: 'b', title: 'task b', status: 'todo' as const },
  ]
  first.saveTasks('bench', input)
  input[0].depends_on?.push('caller-change')
  if (first.listTasks('bench')[0].depends_on?.includes('caller-change')) throw new Error('写入缓存被调用方修改')

  second.listTasks('bench')
  const updated = first.updateTask('bench', 'a', { status: 'done' })
  updated!.depends_on?.push('returned-change')
  second.updateTask('bench', 'b', { status: 'failed' })
  const tasks = first.listTasks('bench')
  if (tasks[0].status !== 'done' || tasks[1].status !== 'failed' || tasks[0].depends_on?.includes('returned-change')) {
    throw new Error('写后缓存或跨实例修改丢失数据')
  }

  first.mutateTasks('bench', (working) => {
    working[0].status = 'cancelled'
    return false
  })
  if (first.listTasks('bench')[0].status !== 'done') throw new Error('无写盘修改污染任务缓存')

  const file = join(root, 'team', 'bench', 'tasks.json')
  const corrupted = '[{"id":"broken"}'
  writeFileSync(file, corrupted)
  let rejected = false
  try {
    first.updateTask('bench', 'a', { status: 'cancelled' })
  } catch (error) {
    rejected = (error as Error).message.includes('任务文件损坏')
  }
  if (!rejected || readFileSync(file, 'utf8') !== corrupted) throw new Error('外部损坏文件被缓存掩盖或覆盖')

  first.saveTasks('bench', [{ id: 'valid', title: 'valid', status: 'todo' }])
  first.mutateTasks('bench', (working) => {
    working.push({ id: 'invalid', title: 'invalid', status: 'not-a-status' } as never)
    return true
  })
  rejected = false
  try {
    first.listTasks('bench')
  } catch (error) {
    rejected = (error as Error).message.includes('任务文件损坏')
  }
  if (!rejected) throw new Error('本实例写入的非法任务被缓存掩盖')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('team_task_cache_test passed')
