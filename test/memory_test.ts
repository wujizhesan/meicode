// 记忆系统测试：指令/会话/笔记
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadInstructions } from '../src/memory/instructions.ts'
import { SessionStore } from '../src/memory/session.ts'
import { updateNotes, buildNotesIndex } from '../src/memory/notes.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

const TMP = join(import.meta.dirname, 'fixtures_mem')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// fake 笔记 provider
class FakeNotesProvider implements Provider {
  readonly protocol = 'openai' as const
  reply: string
  constructor(reply: string) {
    this.reply = reply
  }
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'text', text: this.reply }
    yield { type: 'done' }
  }
}

async function main() {
  // ---------- 指令加载 ----------
  await check('指令: 三层拼接高优先级在前', async () => {
    writeFileSync(join(TMP, 'instructions.md'), '项目根指令内容', 'utf8')
    mkdirSync(join(TMP, '.mewcode'), { recursive: true })
    writeFileSync(join(TMP, '.mewcode', 'instructions.md'), '项目级指令内容', 'utf8')
    const text = await loadInstructions(TMP)
    const rootIdx = text.indexOf('项目根指令内容')
    const projIdx = text.indexOf('项目级指令内容')
    if (rootIdx < 0 || projIdx < 0) throw new Error('缺层')
    if (rootIdx > projIdx) throw new Error('项目根应在前')
  })

  await check('指令: @include 展开', async () => {
    mkdirSync(join(TMP, 'includes'), { recursive: true })
    writeFileSync(join(TMP, 'includes', 'extra.md'), '被包含的内容', 'utf8')
    writeFileSync(join(TMP, 'instructions.md'), '主文件\n@include includes/extra.md\n尾部', 'utf8')
    const text = await loadInstructions(TMP)
    if (!text.includes('被包含的内容')) throw new Error('include 未展开')
    if (!text.includes('主文件') || !text.includes('尾部')) throw new Error('主文件内容缺失')
  })

  await check('指令: @include 环路防死循环', async () => {
    writeFileSync(join(TMP, 'a.md'), '@include b.md', 'utf8')
    writeFileSync(join(TMP, 'b.md'), '@include a.md', 'utf8')
    writeFileSync(join(TMP, 'instructions.md'), '开头\n@include a.md', 'utf8')
    const text = await loadInstructions(TMP)
    if (!text.includes('开头')) throw new Error('主文件缺失')
    // 不应无限递归（能返回即通过）
  })

  await check('指令: @include 越界拦截', async () => {
    writeFileSync(join(TMP, 'instructions.md'), '主\n@include ../outside_secret.md', 'utf8')
    const text = await loadInstructions(TMP)
    if (text.includes('outside_secret')) throw new Error('越界文件被包含')
    if (!text.includes('主')) throw new Error('主文件缺失')
  })

  // ---------- 会话存档 ----------
  await check('会话: JSONL 追加与恢复', async () => {
    const dir = join(TMP, 'sessions')
    const store = new SessionStore(dir)
    const id = '20260809-120000-test'
    store.append(id, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '回复' },
    ])
    const latest = store.recoverLatest()
    if (!latest || latest.id !== id) throw new Error('恢复失败')
    if (latest.messages.length !== 2) throw new Error(`消息数 ${latest.messages.length}`)
    const listed = store.listSessions(10).find((session) => session.id === id)
    if (listed?.count !== 2) throw new Error(`会话列表消息数 ${listed?.count}`)
  })

  await check('会话: 坏行跳过', async () => {
    const dir = join(TMP, 'sessions')
    const store = new SessionStore(dir)
    const id = '20260809-120100-bad'
    store.append(id, [{ role: 'user', content: 'ok' }])
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, readFileSync(file, 'utf8') + '{bad json line}\n{"role":"assistant","content":"after bad"}', 'utf8')
    const latest = store.recoverLatest()
    if (!latest || latest.messages.length !== 2) throw new Error(`坏行未跳过: ${latest?.messages.length}`)
  })

  await check('会话: 工具调用无结果截断', async () => {
    const dir = join(TMP, 'sessions')
    const store = new SessionStore(dir)
    const id = '20260809-120200-cut'
    store.append(id, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      // 缺 tool 结果——应截断掉这条不完整的
    ])
    const latest = store.recoverLatest()
    if (!latest || latest.messages.length !== 1) throw new Error(`应截断到 1 条: ${latest?.messages.length}`)
  })

  await check('会话: 中间不完整轮被清理', async () => {
    const dir = join(TMP, 'sessions')
    const store = new SessionStore(dir)
    const id = '20260809-120300-mid'
    store.append(id, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '完整轮回复' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
      // 缺 tool 结果（中间的不完整轮）——应被删除，后续消息保留
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: '后续完整回复' },
    ])
    const latest = store.recoverLatest()
    if (!latest) throw new Error('恢复失败')
    const bad = latest.messages.find((m) => m.role === 'assistant' && m.tool_calls)
    if (bad) throw new Error('不完整 assistant 未清理')
    if (latest.messages.some((m) => m.content === '后续完整回复')) throw new Error('后续完整消息被误删')
  })

  await check('会话: 非法 ID 不得越界访问', async () => {
    const dir = join(TMP, 'sessions-safe')
    const store = new SessionStore(dir)
    const outside = join(TMP, 'outside-session.jsonl')
    let rejected = false
    try {
      store.append('../outside-session', [{ role: 'user', content: 'blocked' }])
    } catch {
      rejected = true
    }
    if (!rejected || existsSync(outside)) throw new Error('非法 ID 未被拒绝')
    if (store.recoverById('../outside-session') !== null) throw new Error('非法 ID 被恢复')
    if (store.removeById('../outside-session')) throw new Error('非法 ID 被删除')
  })

  await check('会话: 30 天清理', async () => {
    const dir = join(TMP, 'sessions')
    const store = new SessionStore(dir)
    const oldId = '20260101-000000-old'
    store.append(oldId, [{ role: 'user', content: 'old' }])
    // 伪造 31 天前的 mtime
    const oldFile = join(dir, `${oldId}.jsonl`)
    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000)
    utimesSync(oldFile, past, past)
    const removed = store.cleanup(30)
    if (removed < 1) throw new Error('过期会话未清理')
    if (existsSync(oldFile)) throw new Error('旧文件仍存在')
  })

  // ---------- 自动笔记 ----------
  await check('笔记: fake LLM 创建笔记文件', async () => {
    const userDir = join(TMP, 'mem_user')
    const projDir = join(TMP, 'mem_proj')
    const p = new FakeNotesProvider(
      '{"notes":[{"category":"user_pref","title":"喜欢简洁回答","content":"用户偏好简洁直接","action":"create"}]}',
    )
    await updateNotes(p, [{ role: 'user', content: '以后回答简洁点' }], { userDir, projectDir: projDir })
    const files = readdirFiles(userDir)
    if (files.length !== 1) throw new Error(`笔记未创建: ${files.length}`)
    const content = readFileSync(files[0], 'utf8')
    if (!content.includes('category: user_pref') || !content.includes('喜欢简洁回答')) throw new Error('frontmatter 缺失')
  })

  await check('笔记: update 更新同名不新增', async () => {
    const userDir = join(TMP, 'mem_user')
    const projDir = join(TMP, 'mem_proj')
    const p = new FakeNotesProvider(
      '{"notes":[{"category":"user_pref","title":"喜欢简洁回答","content":"更新后的内容","action":"update"}]}',
    )
    await updateNotes(p, [{ role: 'user', content: '再简洁点' }], { userDir, projectDir: projDir })
    const files = readdirFiles(userDir)
    if (files.length !== 1) throw new Error(`update 应更新不新增: ${files.length}`)
    const content = readFileSync(files[0], 'utf8')
    if (!content.includes('更新后的内容')) throw new Error('内容未更新')
  })

  await check('笔记: 坏 JSON 静默', async () => {
    const userDir = join(TMP, 'mem_user')
    const projDir = join(TMP, 'mem_proj')
    const p = new FakeNotesProvider('这不是 JSON')
    await updateNotes(p, [{ role: 'user', content: 'x' }], { userDir, projectDir: projDir }) // 不应抛
  })

  await check('笔记: 索引生成与分类归属', async () => {
    const userDir = join(TMP, 'mem_user')
    const projDir = join(TMP, 'mem_proj')
    const p = new FakeNotesProvider(
      '{"notes":[{"category":"project_knowledge","title":"技术栈","content":"TypeScript + Node","action":"create"}]}',
    )
    await updateNotes(p, [{ role: 'user', content: '技术栈是什么' }], { userDir, projectDir: projDir })
    const index = buildNotesIndex(userDir, projDir)
    if (!index.includes('[项目知识](1条)') || !index.includes('- 技术栈')) throw new Error(`索引缺失: ${index}`)
    if (!index.includes('[用户偏好](1条)') || !index.includes('- 喜欢简洁回答')) throw new Error('用户笔记未入索引')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

function readdirFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md').map((f) => join(dir, f))
}

main().catch((e) => {
  console.error('memory 测试异常:', e)
  process.exit(1)
})
