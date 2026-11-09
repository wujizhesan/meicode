import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { TeamMail } from '../src/team/mail.ts'
import { createLeadTools } from '../src/team/lead-tools.ts'
import type { TeamManager } from '../src/team/index.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-mail-pagination-'))
if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试目录不在临时目录内')
try {
  const mailDir = join(root, 'mail')
  mkdirSync(mailDir)
  const direct = Array.from({ length: 120 }, (_, index) => ({
    messageId: `m${index}`,
    from: 'alice',
    to: 'lead',
    body: `message ${index}`,
    ts: index,
    read: false,
  }))
  writeFileSync(join(mailDir, 'lead.mail'), `${direct.map((message) => JSON.stringify(message)).join('\n')}\n`)
  writeFileSync(join(mailDir, 'broadcast.mail'), `${JSON.stringify({ messageId: 'broadcast', from: 'alice', to: '*', body: 'broadcast', ts: 120, read: false })}\n`)
  const mail = new TeamMail(mailDir)
  const team = { readLeadMailPage: (options: Parameters<TeamMail['readPage']>[1]) => mail.readPage('lead', options) } as unknown as TeamManager
  const tool = createLeadTools(team).find((item) => item.name === 'team_mail')!
  const list = await tool.execute({ action: 'list' }, { cwd: root })
  if (!list.success || !list.output.includes('共 121 封未读') || list.output.split('\n').filter((line) => line.startsWith('[')).length !== 50) {
    throw new Error('未读邮件默认分页失败')
  }

  let cursor: string | undefined
  const pageSizes: number[] = []
  for (let page = 0; page < 3; page++) {
    const result = await tool.execute({ action: 'read', limit: 50, ...(cursor ? { cursor } : {}) }, { cwd: root })
    if (!result.success) throw new Error(`分页读取失败: ${result.error}`)
    pageSizes.push(result.output.split('\n').filter((line) => line.startsWith('[')).length)
    const next = result.output.match(/^下一页参数：(.*)$/m)
    cursor = next ? (JSON.parse(next[1]) as { cursor: string }).cursor : undefined
    if (page === 0) {
      const messages = mail.read('lead')
      if (messages.filter((message) => message.read).length !== 50 || messages.filter((message) => !message.read).length !== 71) {
        throw new Error('分页读取误标记了未展示的邮件')
      }
      const remaining = await tool.execute({ action: 'list' }, { cwd: root })
      if (!remaining.output.includes('共 71 封未读')) throw new Error('未读总数未随本页已读更新')
    }
  }
  if (pageSizes.join(',') !== '50,50,21' || cursor !== undefined || mail.read('lead').some((message) => !message.read)) {
    throw new Error(`邮件分页有遗漏或重复: ${pageSizes}`)
  }
  const invalidLimit = await tool.execute({ action: 'read', limit: 101 }, { cwd: root })
  const invalidCursor = await tool.execute({ action: 'read', cursor: 'bad' }, { cwd: root })
  if (invalidLimit.success || invalidCursor.success) throw new Error('非法分页参数未被拒绝')

  const stableDir = join(root, 'stable')
  mkdirSync(stableDir)
  const stableFile = join(stableDir, 'lead.mail')
  writeFileSync(stableFile, [0, 1, 2].map((index) => JSON.stringify({ messageId: `stable-${index}`, from: 'alice', to: 'lead', body: `stable ${index}`, ts: index, read: false })).join('\n') + '\n')
  const stableMail = new TeamMail(stableDir)
  const first = stableMail.readPage('lead', { limit: 1 })
  appendFileSync(stableFile, `${JSON.stringify({ messageId: 'inserted', from: 'alice', to: 'lead', body: 'inserted', ts: 1.5, read: false })}\n`)
  const older = stableMail.readPage('lead', { limit: 3, cursor: first.nextCursor })
  if (first.messages[0]?.messageId !== 'stable-2' || older.messages.map((message) => message.messageId).join(',') !== 'inserted,stable-1,stable-0') {
    throw new Error('分页期间插入旧时间邮件后游标跳过了消息')
  }

  const legacyDir = join(root, 'legacy')
  mkdirSync(legacyDir)
  const legacy = JSON.stringify({ from: 'alice', to: 'lead', body: 'same', ts: 1, read: false })
  writeFileSync(join(legacyDir, 'lead.mail'), `${legacy}\n${legacy}\n`)
  const legacyMail = new TeamMail(legacyDir)
  const legacyPage = legacyMail.readPage('lead', { limit: 1, markRead: true })
  const legacyMessages = legacyMail.read('lead')
  if (legacyMessages[0]?.read || !legacyMessages[1]?.read || legacyPage.nextCursor !== 'index:1') {
    throw new Error('无 ID 的重复旧邮件被批量标已读或游标错误')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('team_mail_pagination_test passed')
