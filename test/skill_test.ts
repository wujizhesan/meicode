// Skill 系统测试：解析/覆盖/管理/白名单/load_skill/runIsolated
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillManager, loadAllSkills, parseSkillFile, createLoadSkillTool, runIsolated } from '../src/skill/index.ts'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import { History } from '../src/session/history.ts'
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

const TMP = join(import.meta.dirname, 'fixtures_skill')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const BUILTIN = join(TMP, 'builtin')
const USER = join(TMP, 'user')
const PROJECT = join(TMP, 'project')
mkdirSync(BUILTIN, { recursive: true })
mkdirSync(USER, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

function skillMd(name: string, desc: string, extra = ''): string {
  return `---
name: ${name}
description: ${desc}
tools: [run_command, read_file]
mode: shared
${extra}---
# ${name} Skill

SOP 内容 {{message}} 占位
`
}

function makeManager(): SkillManager {
  return new SkillManager({ builtin: BUILTIN, user: USER, project: PROJECT })
}

// fake provider：可配置
class FakeSkillProvider implements Provider {
  readonly protocol = 'openai' as const
  reply: string
  constructor(reply = '这是摘要') {
    this.reply = reply
  }
  async *streamChat(messages: ChatMessage[], opts: { tools?: unknown }): AsyncGenerator<StreamEvent> {
    // 摘要请求（系统提示含「压缩」）返回 reply；主请求返回文本
    const isSummary = messages.some((m) => m.content.includes('压缩成'))
    yield { type: 'text', text: isSummary ? this.reply : '任务输出内容' }
    yield { type: 'done' }
  }
}

async function main() {
  // ---------- 解析 ----------
  await check('解析: frontmatter 与正文', () => {
    const file = join(BUILTIN, 'commit.md')
    writeFileSync(file, skillMd('commit', '提交变更'), 'utf8')
    const def = parseSkillFile(file, 'builtin')
    if (!def || def.name !== 'commit' || def.mode !== 'shared') throw new Error(`解析失败: ${JSON.stringify(def)}`)
    if (!def.content.includes('{{message}}')) throw new Error('正文占位符缺失')
  })
  await check('解析: 坏 frontmatter 跳过', () => {
    writeFileSync(join(BUILTIN, 'bad.md'), '没有 frontmatter 的文件', 'utf8')
    const def = parseSkillFile(join(BUILTIN, 'bad.md'), 'builtin')
    if (def !== null) throw new Error('坏文件应返回 null')
  })
  await check('解析: 目录型 SKILL.md', () => {
    mkdirSync(join(PROJECT, 'my-skill'), { recursive: true })
    writeFileSync(join(PROJECT, 'my-skill', 'SKILL.md'), skillMd('my-skill', '目录型'), 'utf8')
    const { skills } = loadAllSkills({ builtin: BUILTIN, user: USER, project: PROJECT })
    if (!skills.some((s) => s.name === 'my-skill')) throw new Error('目录型未识别')
  })

  // ---------- 三级覆盖 ----------
  await check('覆盖: 项目同名盖内置', () => {
    writeFileSync(join(USER, 'commit.md'), skillMd('commit', '用户版提交', 'model: gpt-x\n'), 'utf8')
    writeFileSync(join(PROJECT, 'commit.md'), skillMd('commit', '项目版提交', 'history: 3\n'), 'utf8')
    const manager = makeManager()
    manager.loadAll()
    const commit = manager.get('commit')
    if (!commit || commit.source !== 'project') throw new Error(`覆盖失败: ${commit?.source}`)
    if (commit.history !== 3) throw new Error('项目版字段未生效')
  })

  // ---------- manager ----------
  await check('manager: index 格式', () => {
    const manager = makeManager()
    manager.loadAll()
    const idx = manager.index()
    if (!idx.includes('commit: 项目版提交')) throw new Error(`index 缺失: ${idx}`)
  })
  await check('manager: activate + activePrompt 参数替换', () => {
    const manager = makeManager()
    manager.loadAll()
    const r = manager.activate('commit', { message: 'fix: 测试' })
    if (!r.includes('已激活')) throw new Error(`激活失败: ${r}`)
    const prompt = manager.activePrompt()
    if (!prompt.includes('fix: 测试')) throw new Error('占位符未替换')
    if (!prompt.includes('已激活 Skill: commit')) throw new Error('激活标记缺失')
  })
  await check('manager: 多激活拼接 + 白名单并集', () => {
    writeFileSync(
      join(USER, 'test.md'),
      '---\nname: test\ndescription: 跑测试\ntools: [run_command]\nmode: shared\n---\n# Test Skill\n',
      'utf8',
    )
    const manager = makeManager()
    manager.loadAll()
    manager.activate('commit')
    manager.activate('test')
    const prompt = manager.activePrompt()
    if (!prompt.includes('commit') || !prompt.includes('test')) throw new Error('多激活缺失')
    const tools = manager.activeToolNames()
    if (!tools || !tools.includes('run_command') || !tools.includes('read_file')) throw new Error(`并集错误: ${tools}`)
  })
  await check('manager: clear 清空激活', () => {
    const manager = makeManager()
    manager.loadAll()
    manager.activate('commit')
    manager.clear()
    if (manager.activeToolNames() !== null) throw new Error('clear 未清空')
  })
  await check('manager: 白名单未知工具警告跳过', () => {
    writeFileSync(
      join(PROJECT, 'badskill.md'),
      '---\nname: badskill\ndescription: 坏白名单\ntools: [no_such_tool]\nmode: shared\n---\n# Bad Skill\n',
      'utf8',
    )
    const manager = makeManager()
    const { unavailable } = manager.loadAll()
    if (!unavailable.includes('badskill')) throw new Error(`未标记不可用: ${unavailable}`)
    if (manager.get('badskill')) throw new Error('不可用 Skill 不应可加载')
  })

  // ---------- load_skill 工具 ----------
  await check('load_skill: 激活返回正确', async () => {
    const manager = makeManager()
    manager.loadAll()
    const tool = createLoadSkillTool(manager)
    const r = await tool.execute({ name: 'commit' }, { cwd: TMP })
    if (!r.success || !r.output.includes('已激活')) throw new Error(`load_skill 失败: ${JSON.stringify(r)}`)
    if (!manager.isActive('commit')) throw new Error('未激活')
  })
  await check('load_skill: 未知 Skill 报错', async () => {
    const manager = makeManager()
    manager.loadAll()
    const tool = createLoadSkillTool(manager)
    const r = await tool.execute({ name: 'nope' }, { cwd: TMP })
    if (r.success) throw new Error('未知 Skill 应失败')
  })

  // ---------- runIsolated ----------
  await check('runIsolated: 独立会话 + 摘要回流', async () => {
    const manager = makeManager()
    manager.loadAll()
    const def = manager.get('commit')
    if (!def) throw new Error('commit 缺失')
    const registry = new ToolRegistry()
    createTools({ cwd: TMP }).forEach((t) => registry.register(t))
    const history = new History()
    history.push({ role: 'user', content: '问题' })
    const p = new FakeSkillProvider('摘要：任务完成')
    const summary = await runIsolated(def, history, {
      provider: p,
      registry,
      ctx: { cwd: TMP },
      systemPrompt: 'system',
    })
    if (!summary.includes('摘要')) throw new Error(`摘要不符: ${summary}`)
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('skill 测试异常:', e)
  process.exit(1)
})
