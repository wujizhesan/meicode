import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SubAgentManager, SubAgentStore } from '../src/subagent/index.ts'

const root = join(import.meta.dirname, 'fixtures_subagent_persistence')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const store = new SubAgentStore(root, 'session_test')
store.save({ id: 'agent_old', role: 'worker', type: 'defined', status: 'running', startedAt: 1 })
const isolated = store.load()
isolated[0].role = 'mutated'
if (store.load()[0].role !== 'worker') throw new Error('Store 缓存被调用方修改')
const dirs = { builtin: join(root, 'builtin'), user: join(root, 'user'), project: join(root, 'project') }
const manager = new SubAgentManager(dirs, null, store)
const recovered = manager.getRecord('agent_old')
if (recovered?.status !== 'error' || !recovered.error || !recovered.finishedAt) throw new Error('运行中的子 Agent 未恢复为错误状态')

store.save({
  id: 'agent_live',
  role: 'worker',
  type: 'fork',
  status: 'running',
  startedAt: Date.now(),
  ownerId: 'owner-live',
  leaseExpiresAt: Date.now() + 60000,
})
const concurrentManager = new SubAgentManager(dirs, null, store)
if (concurrentManager.getRecord('agent_live')?.status !== 'running') throw new Error('其他进程的有效子 Agent 租约被误回收')
const staleOverwrite = store.save({
  id: 'agent_live',
  role: 'worker',
  type: 'fork',
  status: 'done',
  startedAt: Date.now(),
  finishedAt: Date.now(),
}, 'owner-stale')
if (staleOverwrite || store.load().find((record) => record.id === 'agent_live')?.status !== 'running') throw new Error('错误 owner 覆盖了活动子 Agent')
if (!store.renewLease('agent_live', 'owner-live', Date.now() + 120000)) throw new Error('活动子 Agent 租约续期失败')
if (!concurrentManager.cancel('agent_live', 'session_test')) throw new Error('非 owner 进程未持久化取消请求')
const renewedAfterCancel = store.renewLease('agent_live', 'owner-live', Date.now() + 120000)
if (!renewedAfterCancel?.cancelRequestedAt) throw new Error('owner 进程未观察到跨进程取消请求')
const liveFinished = store.load().find((record) => record.id === 'agent_live')!
liveFinished.status = 'done'
liveFinished.finishedAt = Date.now()
delete liveFinished.ownerId
delete liveFinished.leaseExpiresAt
if (!store.save(liveFinished, 'owner-live')) throw new Error('owner 无法提交子 Agent 终态')
if (concurrentManager.getRecord('agent_live')?.status !== 'cancelled') throw new Error('迟到成功覆盖了跨进程取消终态')

store.save({
  id: 'agent_cancel_expired',
  role: 'worker',
  type: 'fork',
  status: 'running',
  startedAt: 1,
  ownerId: 'owner-expired-cancel',
  leaseExpiresAt: 2,
})
if (store.requestCancel('agent_cancel_expired')?.status !== 'cancelled') throw new Error('过期租约取消请求未直接收敛')

store.save({
  id: 'agent_later_expired',
  role: 'worker',
  type: 'fork',
  status: 'running',
  startedAt: Date.now(),
  ownerId: 'owner-later',
  leaseExpiresAt: Date.now() + 60000,
})
const waitingManager = new SubAgentManager(dirs, null, store)
const laterExpired = store.load().find((record) => record.id === 'agent_later_expired')!
laterExpired.leaseExpiresAt = 2
if (!store.save(laterExpired, 'owner-later')) throw new Error('无法模拟后续租约过期')
if (waitingManager.getRecord('agent_later_expired')?.status !== 'error') throw new Error('启动后才过期的子 Agent 未被回收')

store.save({
  id: 'agent_expired',
  role: 'worker',
  type: 'fork',
  status: 'running',
  startedAt: 1,
  ownerId: 'owner-expired',
  leaseExpiresAt: 2,
})
const recoveryManager = new SubAgentManager(dirs, null, store)
const expired = recoveryManager.getRecord('agent_expired')
if (expired?.status !== 'error' || expired.ownerId || expired.leaseExpiresAt) throw new Error('过期子 Agent 租约未安全回收')

store.save({ id: 'agent_done', role: 'worker', type: 'fork', status: 'done', startedAt: 2, result: '完成' })
const secondStore = new SubAgentStore(root, 'session_test')
secondStore.save({ id: 'agent_second', role: 'worker', type: 'fork', status: 'done', startedAt: 3, result: '第二条' })
const secondManager = new SubAgentManager(dirs, null, store)
if (secondManager.getRecord('agent_done')?.result !== '完成') throw new Error('已完成子 Agent 记录未加载')
if (secondManager.getRecord('agent_second')?.result !== '第二条') throw new Error('并行 Store 保存的记录丢失')

const slashStore = new SubAgentStore(root, 'a/b')
const underscoreStore = new SubAgentStore(root, 'a_b')
slashStore.save({ id: 'agent_slash', role: 'worker', type: 'fork', status: 'done', startedAt: 4 })
underscoreStore.save({ id: 'agent_underscore', role: 'worker', type: 'fork', status: 'done', startedAt: 5 })
if (slashStore.load().length !== 1 || underscoreStore.load().length !== 1) throw new Error('不同 session id 文件碰撞')

writeFileSync(join(root, 'session_invalid.json'), JSON.stringify([
  { id: 'valid', role: 'worker', type: 'fork', status: 'done', startedAt: 1 },
  { id: 'invalid', role: 'worker', type: 'bad', status: 'done', startedAt: 'x' }
]), 'utf8')
const invalidStore = new SubAgentStore(root, 'session_invalid')
if (invalidStore.load().length !== 0) throw new Error('包含非法项的 Store 未整体隔离')
if (!readdirSync(root).some((name) => name.startsWith('session_invalid.json.corrupt.'))) throw new Error('非法结构 Store 未保留隔离副本')

writeFileSync(join(root, 'session_test.json'), '{broken', 'utf8')
if (store.load().length !== 0) throw new Error('损坏 Store 未安全降级')
if (!readdirSync(root).some((name) => name.startsWith('session_test.json.corrupt.'))) throw new Error('损坏 Store 未保留备份')

rmSync(root, { recursive: true, force: true })
console.log('subagent_persistence_test passed')
