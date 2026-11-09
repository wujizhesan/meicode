import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ChatMessage, Provider } from '../provider/types.ts'

// 对齐 Qoder 结构化记忆(27 类精简为 6 类)：分类 = 检索索引,按类分组注入
export type NoteCategory = 'user_pref' | 'correction' | 'project_knowledge' | 'reference' | 'lesson' | 'workflow'

interface NoteUpdate {
  category: NoteCategory
  title: string
  content: string
  action: 'create' | 'update'
}

const NOTE_CATEGORIES = new Set<NoteCategory>(['user_pref', 'correction', 'project_knowledge', 'reference', 'lesson', 'workflow'])

function parseNote(value: unknown): NoteUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { category, title, content, action } = value as Record<string, unknown>
  if (typeof category !== 'string' || !NOTE_CATEGORIES.has(category as NoteCategory)
    || typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)
    || typeof content !== 'string' || !content.trim()
    || (action !== 'create' && action !== 'update')) return null
  return { category: category as NoteCategory, title: title.trim(), content: content.trim(), action }
}

const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25000
const INDEX_TRUNCATION_SUFFIX = '\n…[记忆索引超限已截断]'

const NOTES_PROMPT = `你是 MeiCode 的记忆整理器。分析最近一轮对话，决定哪些信息值得长期记住。

硬性要求：
- 禁止调用任何工具
- 只输出 JSON，不要任何其他文字，格式：
{"notes":[{"category":"user_pref|correction|project_knowledge|reference|lesson|workflow","title":"简短标题","content":"一句话要点","action":"create|update"}]}

分类说明：
- user_pref: 用户偏好（语气、风格、工作习惯）
- correction: 纠正反馈（用户纠正过你的做法）
- project_knowledge: 项目知识（技术栈、架构、约定）
- reference: 参考资料（有用链接、文档位置）
- lesson: 踩坑记录（遇到过的坑 + 解法，避免再犯）
- workflow: 任务拆解/流程模板（可复用的多步流程）

去重规则：
- 参考下方现有记忆索引——标题已存在的用 action=update（更新内容），否则 create
- 不值得长期记住的（一次性对话、临时任务）输出 {"notes":[]}`

interface CachedNoteMeta {
  mtimeMs: number
  ctimeMs: number
  size: number
  category: string
  title: string
  firstLine: string
}

const noteMetaCache = new Map<string, CachedNoteMeta>()
const noteTitleCache = new Map<string, Map<string, string>>()

function readNoteMeta(file: string, fallbackTitle: string): CachedNoteMeta {
  const stat = statSync(file)
  const cached = noteMetaCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) return cached
  const content = readFileSync(file, 'utf8')
  const meta: CachedNoteMeta = {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    category: content.match(/^category:\s*(.+)$/m)?.[1] ?? 'other',
    title: content.match(/^title:\s*(.+)$/m)?.[1] ?? fallbackTitle,
    firstLine: content.split('\n').find((line) => line.trim() && !line.startsWith('---') && !line.includes(':'))?.trim() ?? '',
  }
  noteMetaCache.set(file, meta)
  return meta
}

export function buildNotesIndex(userDir: string, projectDir: string): string {
  // 按类别分组（对齐 Qoder 结构化记忆）：模型找"用户偏好/踩坑"直接定位,不扫全量
  const byCat = new Map<string, string[]>()
  for (const dir of [projectDir, userDir]) {
    if (!existsSync(dir)) continue
    const titles = new Map<string, string>()
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md').sort()) {
      const file = join(dir, f)
      const meta = readNoteMeta(file, f)
      if (!titles.has(meta.title)) titles.set(meta.title, file)
      const list = byCat.get(meta.category) ?? []
      const preview = meta.firstLine.slice(0, 80).replace(/[\uD800-\uDBFF]$/, '')
      list.push(`- ${meta.title} — ${preview}`)
      byCat.set(meta.category, list)
    }
    noteTitleCache.set(dir, titles)
  }
  const CAT_LABEL: Record<string, string> = {
    user_pref: '用户偏好',
    correction: '纠正反馈',
    project_knowledge: '项目知识',
    reference: '参考资料',
    lesson: '踩坑记录',
    workflow: '流程模板',
  }
  const groups: string[] = []
  for (const [cat, list] of byCat) {
    groups.push(`[${CAT_LABEL[cat] ?? cat}](${list.length}条)\n${list.join('\n')}`)
  }
  let text = groups.join('\n\n')
  // 硬上限：200 行 / 25KB
  const lines = text.split('\n')
  if (lines.length > MAX_INDEX_LINES || Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) {
    const content = Buffer.from(lines.slice(0, MAX_INDEX_LINES - 1).join('\n'), 'utf8')
    let end = Math.min(content.length, MAX_INDEX_BYTES - Buffer.byteLength(INDEX_TRUNCATION_SUFFIX, 'utf8'))
    while (end > 0 && (content[end] & 0xc0) === 0x80) end--
    text = content.subarray(0, end).toString('utf8') + INDEX_TRUNCATION_SUFFIX
  }
  return text || '（暂无记忆）'
}

// 异步更新笔记（调用方 fire-and-forget）
export async function updateNotes(
  provider: Provider,
  recent: ChatMessage[],
  opts: { userDir: string; projectDir: string; signal?: AbortSignal },
): Promise<void> {
  opts.signal?.throwIfAborted()
  const index = buildNotesIndex(opts.userDir, opts.projectDir)
  const msgs: ChatMessage[] = [
    { role: 'system', content: NOTES_PROMPT },
    { role: 'system', content: `现有记忆索引：\n${index}` },
    ...recent,
  ]

  const textParts: string[] = []
  for await (const ev of provider.streamChat(msgs, { thinking: false, signal: opts.signal })) {
    opts.signal?.throwIfAborted()
    if (ev.type === 'text') textParts.push(ev.text)
    else if (ev.type === 'error') throw new Error(`笔记请求失败: ${ev.message}`)
  }
  opts.signal?.throwIfAborted()
  const text = textParts.join('')

  let parsed: unknown
  try {
    // 容忍 JSON 被 ``` 包裹
    const cleaned = text.replace(/```json|```/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return // 解析失败静默
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const notes = (parsed as Record<string, unknown>).notes
  if (!Array.isArray(notes)) return
  for (const value of notes) {
    const note = parseNote(value)
    if (!note) continue
    opts.signal?.throwIfAborted()
    const dir = note.category === 'user_pref' || note.category === 'correction' ? opts.userDir : opts.projectDir
    mkdirSync(dir, { recursive: true })

    if (note.action === 'update') {
      // 找同名标题的现有笔记更新
      const existing = findNoteByTitle(dir, note.title)
      if (existing) {
        writeFileSync(existing, renderNote(note), 'utf8')
        continue
      }
    }
    const slug = note.title.replace(/[^\w一-龥-]/g, '-').slice(0, 40)
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}-${Date.now().toString(36)}-${randomUUID()}.md`)
    writeFileSync(file, renderNote(note), { encoding: 'utf8', flag: 'wx' })
  }
}

function findNoteByTitle(dir: string, title: string): string | null {
  if (!existsSync(dir)) return null
  const indexed = noteTitleCache.get(dir)?.get(title)
  if (indexed && existsSync(indexed) && readNoteMeta(indexed, title).title === title) return indexed
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md')) {
    const file = join(dir, f)
    if (file === indexed) continue
    if (readNoteMeta(file, f).title === title) return file
  }
  return null
}

function renderNote(note: NoteUpdate): string {
  const date = new Date().toISOString().slice(0, 10)
  return `---
category: ${note.category}
date: ${date}
title: ${note.title}
---

${note.content}
`
}
