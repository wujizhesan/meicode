import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { TeamGroupStore } from '../src/team/group.ts'

const root = join(import.meta.dirname, 'fixtures_team_process')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

function worker(mode: 'claim' | 'member' | 'group', name: string): Promise<string> {
  const script = mode === 'claim'
    ? `import { TeamGroupStore } from './src/team/group.ts'; const store = new TeamGroupStore(process.env.TEAM_ROOT); const result = store.claimTask('claim', 'shared', { status: 'in_progress', assignee: process.env.WORKER }); process.stdout.write(result ? 'won' : 'lost')`
    : mode === 'member'
      ? `import { TeamGroupStore } from './src/team/group.ts'; const store = new TeamGroupStore(process.env.TEAM_ROOT); const group = store.loadGroup('members'); if (!group) process.exit(2); store.addMember(group, { name: process.env.WORKER, role: 'worker', workdir: process.cwd(), backend: 'coroutine', needsApproval: false, status: 'idle' }); process.stdout.write('ok')`
      : `import { TeamGroupStore } from './src/team/group.ts'; const store = new TeamGroupStore(process.env.TEAM_ROOT); store.createGroup('members', 'lead'); process.stdout.write('ok')`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, TEAM_ROOT: root, WORKER: name },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { error += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`worker ${name} exit=${code}: ${error}`)))
  })
}

const store = new TeamGroupStore(root)
store.createGroup('claim', 'lead')
store.saveTasks('claim', [{ id: 'shared', title: 'shared', status: 'todo' }])
const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => worker('claim', `worker-${i}`)))
if (claims.filter((result) => result === 'won').length !== 1) throw new Error(`跨进程领取胜者数量错误: ${claims.join(',')}`)
if (store.listTasks('claim')[0]?.status !== 'in_progress') throw new Error('跨进程领取状态未落盘')

store.createGroup('members', 'lead')
const members = await Promise.all(Array.from({ length: 8 }, (_, i) => worker('member', `member-${i}`)))
if (members.some((result) => result !== 'ok')) throw new Error('跨进程成员注册失败')
const registered = store.loadGroup('members')?.members ?? []
if (registered.length !== 8 || new Set(registered.map((member) => member.name)).size !== 8) throw new Error(`跨进程成员注册丢失: ${registered.map((member) => member.name).join(',')}`)
const duplicateCreates = await Promise.all(Array.from({ length: 8 }, (_, i) => worker('group', `creator-${i}`)))
if (duplicateCreates.some((result) => result !== 'ok')) throw new Error('跨进程重复建组失败')
const afterDuplicateCreate = store.loadGroup('members')?.members ?? []
if (afterDuplicateCreate.length !== 8) throw new Error(`跨进程重复建组覆盖成员: ${afterDuplicateCreate.length}`)

rmSync(root, { recursive: true, force: true })
console.log('team_process_test passed')
