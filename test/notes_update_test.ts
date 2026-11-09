import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { updateNotes } from '../src/memory/notes.ts'
import { createNotesUpdater } from '../src/memory/notes-updater.ts'
import type { Provider } from '../src/provider/types.ts'

let passed = 0
let failed = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_notes_update_'))
const tick = () => new Promise<void>((done) => setImmediate(done))

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${String(error)}`)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function options(name: string) {
  return { userDir: join(root, name, 'user'), projectDir: join(root, name, 'project') }
}

function response(text: string): Provider {
  return { protocol: 'openai', async *streamChat() { yield { type: 'text', text }; yield { type: 'done' } } }
}

const note = (title: string) => ({ category: 'project_knowledge', title, content: `${title}的内容`, action: 'create' })

function pendingProvider() {
  const requests: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred>; closed: ReturnType<typeof deferred> }> = []
  const provider: Provider = {
    protocol: 'openai',
    async *streamChat(_messages, opts) {
      assert(opts.signal)
      const request = { signal: opts.signal, gate: deferred(), closed: deferred() }
      requests.push(request)
      try {
        await request.gate.promise
        yield { type: 'text', text: JSON.stringify({ notes: [note('测试笔记')] }) }
        yield { type: 'done' }
      } finally { request.closed.resolve() }
    },
  }
  return { provider, requests, async close() {
    for (const request of requests) request.gate.resolve()
    await Promise.all(requests.map((request) => request.closed.promise))
    await tick()
  } }
}

try {
  await check('异常条目逐条跳过，前后正常笔记都保存且不创建错误分类目录', async () => {
    const opts = options('entries')
    const invalid = [
      null, true, [], 'text',
      { ...note('标题'), title: 42 },
      { ...note('标题'), content: {} },
      { ...note('标题'), category: 'unknown' },
      { ...note('标题'), action: 'delete' },
      { ...note('标题'), title: ' \t' },
      { ...note('标题'), content: ' \n ' },
      { ...note('标题'), title: '标题\n伪元数据' },
      { title: '缺字段', content: '内容' },
    ]
    await updateNotes(response(JSON.stringify({ notes: [note('首条'), ...invalid, note('末条')] })), [], opts)
    const contents = readdirSync(opts.projectDir).map((file) => readFileSync(join(opts.projectDir, file), 'utf8'))
    assert.equal(contents.length, 2)
    assert(contents.some((content) => content.includes('title: 首条\n')))
    assert(contents.some((content) => content.includes('title: 末条\n')))
    assert(!existsSync(opts.userDir))
  })

  await check('合法 JSON 的异常顶层或 notes 类型安全忽略，不产生文件', async () => {
    for (const [index, value] of [null, true, 42, [], {}, { notes: null }, { notes: 'text' }, { notes: {} }].entries()) {
      const opts = options(`top-${index}`)
      await updateNotes(response(JSON.stringify(value)), [], opts)
      assert(!existsSync(opts.userDir))
      assert(!existsSync(opts.projectDir))
    }
  })

  await check('六种有效分类保留归属，并兼容 JSON 代码块', async () => {
    const opts = options('categories')
    const categories = ['user_pref', 'correction', 'project_knowledge', 'reference', 'lesson', 'workflow']
    const notes = categories.map((category) => ({ ...note(category), category }))
    await updateNotes(response('```json\n' + JSON.stringify({ notes }) + '\n```'), [], opts)
    assert.equal(readdirSync(opts.userDir).length, 2)
    assert.equal(readdirSync(opts.projectDir).length, 4)
    for (const category of categories) {
      const dir = category === 'user_pref' || category === 'correction' ? opts.userDir : opts.projectDir
      assert(readdirSync(dir).some((file) => readFileSync(join(dir, file), 'utf8').includes(`category: ${category}\n`)))
    }
  })

  await check('标题与内容去除边缘空白后仍正确更新同名笔记', async () => {
    const opts = options('normalized')
    mkdirSync(opts.projectDir, { recursive: true })
    const file = join(opts.projectDir, 'existing.md')
    writeFileSync(file, '---\ncategory: project_knowledge\ntitle: 同名笔记\n---\n\n原始内容\n')
    await updateNotes(response(JSON.stringify({ notes: [{ ...note('  同名笔记  '), content: '  更新内容  ', action: 'update' }] })), [], opts)
    assert.equal(readdirSync(opts.projectDir).length, 1)
    assert(readFileSync(file, 'utf8').endsWith('\n更新内容\n'))
  })

  await check('取消不响应信号的供应商时及时移除父监听，且不取消父任务', async () => {
    const opts = options('cancel')
    const parent = new AbortController()
    const source = pendingProvider()
    const updater = createNotesUpdater()
    try {
      updater.start(source.provider, [], { ...opts, signal: parent.signal })
      assert.equal(getEventListeners(parent.signal, 'abort').length, 1)
      updater.cancel()
      assert(source.requests[0].signal.aborted)
      assert(!parent.signal.aborted)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      await source.close()
      assert(!existsSync(opts.projectDir))
    } finally { updater.cancel(); await source.close() }
  })

  await check('成功完成笔记后移除父监听，后续取消不误伤已完成请求', async () => {
    const opts = options('success')
    const parent = new AbortController()
    const source = pendingProvider()
    const updater = createNotesUpdater()
    try {
      updater.start(source.provider, [], { ...opts, signal: parent.signal })
      await source.close()
      assert.equal(readdirSync(opts.projectDir).length, 1)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      updater.cancel()
      assert(!parent.signal.aborted)
      assert(!source.requests[0].signal.aborted)
    } finally { updater.cancel(); await source.close() }
  })

  await check('预取消的新任务不会请求模型，并使旧未完成笔记失效', async () => {
    const opts = options('preaborted')
    const source = pendingProvider()
    const updater = createNotesUpdater()
    const parent = new AbortController()
    try {
      updater.start(source.provider, [], opts)
      parent.abort()
      updater.start(source.provider, [], { ...opts, signal: parent.signal })
      assert.equal(source.requests.length, 1)
      assert(source.requests[0].signal.aborted)
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
      await source.close()
      assert(!existsSync(opts.projectDir))
    } finally { updater.cancel(); await source.close() }
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_notes_update_'))
  const verify = (directory: string) => {
    assert(!lstatSync(directory).isSymbolicLink())
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) verify(join(directory, entry.name))
    }
  }
  verify(target)
  rmSync(target, { recursive: true, force: true })
}

console.log(`\nnotes_update_test: ${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
