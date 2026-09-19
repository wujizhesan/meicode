import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemberHost } from '../src/team/member.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-member-history-'))
try {
  const file = join(root, 'member.history.jsonl')
  const prefix = Array.from({ length: 10 }, (_, index) => JSON.stringify({ role: index % 2 ? 'assistant' : 'user', content: `message-${index}` }))
  const tail = JSON.stringify({ role: 'assistant', content: 'tail' })
  writeFileSync(file, `${prefix.join('\n')}\n`, 'utf8')

  const host = new MemberHost(
    { name: 'worker', role: 'worker', workdir: root, backend: 'coroutine', needsApproval: false, status: 'idle' },
    'group',
    { provider: {} as never, registry: {} as never, ctx: { cwd: root }, historyFile: file, store: {} as never, mail: {} as never },
  )
  writeFileSync(file, `${[...prefix, ...prefix, tail].join('\n')}\n`, 'utf8')
  if (host.history.length !== 11) throw new Error(`replayed prefix not removed: ${host.history.length}`)

  host.history.push({ role: 'user', content: 'new task' })
  const persist = () => (host as unknown as { persist(): void }).persist()
  persist()
  const settled = readFileSync(file, 'utf8')
  if (settled.split('\n').filter(Boolean).length !== 12) throw new Error('history was duplicated after resume')
  if ((host.history.length as number) !== 12) throw new Error('in-memory history was cleared')

  persist()
  if (readFileSync(file, 'utf8') !== settled) throw new Error('unchanged history was persisted twice')

  host.history.replaceRange(0, 1, [{ role: 'user', content: 'rewritten' }])
  persist()
  if (JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).content !== 'rewritten') throw new Error('structural history change was not rewritten')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('member_history_test passed')
