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
if (invalidStore.load().length !== 1 || invalidStore.load()[0].id !== 'valid') throw new Error('非法记录未过滤')

writeFileSync(join(root, 'session_test.json'), '{broken', 'utf8')
if (store.load().length !== 0) throw new Error('损坏 Store 未安全降级')
if (!readdirSync(root).some((name) => name.startsWith('session_test.json.corrupt.'))) throw new Error('损坏 Store 未保留备份')

rmSync(root, { recursive: true, force: true })
console.log('subagent_persistence_test passed')
