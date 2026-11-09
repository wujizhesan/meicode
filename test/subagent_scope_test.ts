import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { createLoadSkillTool, SkillManager } from '../src/skill/index.ts'
import { SubAgentManager } from '../src/subagent/manager.ts'
import type { SpawnRequest } from '../src/subagent/types.ts'
import { resolveOnAbort } from '../src/tools/abort.ts'
import { editFileTool } from '../src/tools/edit_file.ts'
import { readFileTool } from '../src/tools/read_file.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { runCommandTool } from '../src/tools/run_command.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { writeFileTool } from '../src/tools/write_file.ts'
import type { WorktreeManager } from '../src/worktree/index.ts'

let passed = 0
let failed = 0
let fixtureId = 0
const root = mkdtempSync(join(import.meta.dirname, 'fixtures_subagent_scope_'))

async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${String(error)}`) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('子 Agent 作用域测试超时')), 4000)
    })])
  } finally { clearTimeout(timer) }
}

function fixture(options: { denyWrite?: boolean; worktree?: boolean; contract?: boolean } = {}) {
  const directory = join(root, String(++fixtureId))
  const roles = join(directory, 'roles')
  const skills = join(directory, 'skills')
  mkdirSync(roles, { recursive: true })
  mkdirSync(skills)
  const writeSkill = (name: string, mode: 'shared' | 'isolated', tools?: string[]) => {
    writeFileSync(join(skills, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\nmode: ${mode}\n${tools === undefined ? '' : `tools: ${JSON.stringify(tools)}\n`}---\nLOCAL-SKILL-${name}\n`)
  }
  writeSkill('parent-guide', 'shared')
  writeSkill('parent-queued', 'isolated')
  const skillManager = new SkillManager({ builtin: join(directory, 'builtin-skills'), user: join(directory, 'user-skills'), project: skills })
  skillManager.loadAll()
  skillManager.activate('parent-guide')
  skillManager.activate('parent-queued')
  const parentPrompt = skillManager.activePrompt()
  const calls = { reads: 0, writes: 0, activations: 0 }
  skillManager.setOnActivate(() => { calls.activations++ })
  const registry = new ToolRegistry()
  registry.register(createLoadSkillTool(skillManager))
  for (const name of ['read_file', 'write_file']) registry.register({
    name, description: name, parameters: { type: 'object' },
    async execute() { if (name === 'read_file') calls.reads++; else calls.writes++; return { success: true, output: `${name} 执行完成` } },
  })
  writeFileSync(join(roles, 'probe.md'), `---\nname: probe\ndescription: 子任务检查\npermission: permissive\nmax_rounds: 8\n${options.denyWrite ? 'tools_deny: [write_file]\n' : ''}${options.worktree ? 'isolation: worktree\n' : ''}${options.contract ? 'write_paths: [.reports]\n' : ''}---\nCHILD-ROLE-PROBE\n`)
  const worktreePath = join(directory, 'worktree')
  const worktrees = options.worktree ? {
    async create() { mkdirSync(worktreePath); return { path: worktreePath, branch: 'test-scope' } },
    async exit() { return { dirty: true, path: worktreePath, branch: 'test-scope' } },
    release() {},
  } as unknown as WorktreeManager : undefined
  const manager = new SubAgentManager({ builtin: join(directory, 'builtin-roles'), user: join(directory, 'user-roles'), project: roles }, worktrees)
  manager.loadRoles()
  const history = new History()
  history.push({ role: 'user', content: 'PARENT-HISTORY' })
  const ctx: ToolContext = {
    cwd: directory, sessionId: 'parent-session', agentId: 'parent-agent',
    permission: { mode: 'permissive', engine: { match: () => null, addSessionRule() {}, appendProjectRule() {} } },
  }
  const request = (type: 'defined' | 'fork', prompt = '子任务', tools = registry.list()): SpawnRequest => ({
    type, role: type === 'defined' ? 'probe' : undefined, prompt,
    ...(type === 'fork' ? { parentHistory: history.all(), parentTools: tools } : {}),
  })
  const assertParentUnchanged = () => {
    assert.equal(skillManager.activePrompt(), parentPrompt)
    assert.equal(skillManager.activeToolNames(), null)
    assert.deepEqual(skillManager.lastActivated, { name: 'parent-queued', mode: 'isolated' })
    assert.equal(calls.activations, 0)
    assert.deepEqual(history.view(), [{ role: 'user', content: 'PARENT-HISTORY' }])
    assert.equal(skillManager.takeNextIsolated()?.name, 'parent-queued')
    assert.equal(skillManager.takeNextIsolated(), undefined)
  }
  return { directory, worktreePath, manager, skillManager, registry, ctx, calls, writeSkill, request, assertParentUnchanged }
}

async function finish(f: ReturnType<typeof fixture>, request: SpawnRequest, provider: Provider) {
  const result = await bounded(f.manager.spawn(request, { provider, registry: f.registry, ctx: f.ctx }))
  const finished = await bounded(f.manager.waitFor(result.id, 3000))
  assert.equal(finished.record?.status, 'done', finished.record?.error ?? '子任务未正常完成')
  return finished.record!
}

try {
  for (const type of ['defined', 'fork'] as const) {
    for (const scenario of [
      { name: '空工具限制', tools: [], expected: ['load_skill'] },
      { name: '仅读工具', tools: ['read_file'], expected: ['load_skill', 'read_file'] },
      { name: '无限制', tools: undefined, expected: ['load_skill', 'read_file', 'write_file'] },
      { name: '不能扩大角色或父工具范围', tools: ['write_file'], restrict: true, expected: ['load_skill'] },
    ]) {
      await check(`${type} 加载共享 Skill：${scenario.name}只在自身生效`, async () => {
        const f = fixture({ denyWrite: scenario.restrict })
        f.writeSkill('child-guide', 'shared', scenario.tools)
        f.skillManager.loadAll()
        const parentTool = f.registry.get('load_skill')
        let rounds = 0
        const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
          if (++rounds === 1) yield { type: 'tool_call', id: 'load-child-guide', name: 'load_skill', arguments: { name: 'child-guide' } }
          else {
            assert(messages.some((message) => message.role === 'system' && message.content.includes('LOCAL-SKILL-child-guide')))
            assert(!messages.some((message) => message.content.includes('LOCAL-SKILL-parent-guide')))
            assert.deepEqual(options.tools!.map((tool) => tool.function.name).sort(), scenario.expected)
            if (rounds === 2) {
              yield { type: 'tool_call', id: 'read-child', name: 'read_file', arguments: {} }
              yield { type: 'tool_call', id: 'write-child', name: 'write_file', arguments: {} }
            } else yield { type: 'text', text: '本地共享 Skill 完成' }
          }
          yield { type: 'done' }
        } }
        try {
          const parentTools = f.registry.list().filter((tool) => !scenario.restrict || tool.name !== 'write_file')
          await finish(f, f.request(type, '共享 Skill 测试', parentTools), provider)
          assert.equal(f.calls.reads, scenario.expected.includes('read_file') ? 1 : 0)
          assert.equal(f.calls.writes, scenario.expected.includes('write_file') ? 1 : 0)
          assert.equal(f.registry.get('load_skill'), parentTool)
          f.assertParentUnchanged()
        } finally { await bounded(f.manager.close(0)) }
      })
    }
  }

  for (const type of ['defined', 'fork'] as const) {
    await check(`${type} 独立 Skill 在子任务收尾执行，结果回流当前报告且保持工具范围`, async () => {
      const f = fixture({ denyWrite: true })
      f.writeSkill('child-isolated', 'isolated', ['write_file'])
      f.skillManager.loadAll()
      let mainRounds = 0
      let children = 0
      let summaries = 0
      const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
        if (messages[0].content.startsWith('把下面的执行输出')) { summaries++; yield { type: 'text', text: 'CHILD-ISOLATED-SUMMARY' } }
        else if (messages[0].content.includes('LOCAL-SKILL-child-isolated')) {
          assert.deepEqual(options.tools!.map((tool) => tool.function.name), ['load_skill'])
          if (++children === 1) yield { type: 'tool_call', id: 'blocked-nested-write', name: 'write_file', arguments: {} }
          else yield { type: 'text', text: '本地独立 Skill 完成' }
        } else if (++mainRounds === 1) yield { type: 'tool_call', id: 'load-child-isolated', name: 'load_skill', arguments: { name: 'child-isolated' } }
        else yield { type: 'text', text: '子 Agent 主流程完成' }
        yield { type: 'done' }
      } }
      try {
        const record = await finish(f, f.request(type, '独立 Skill 测试', f.registry.list().filter((tool) => tool.name !== 'write_file')), provider)
        assert.equal(children, 2)
        assert.equal(summaries, 1)
        assert(record.result!.includes('CHILD-ISOLATED-SUMMARY'))
        assert.equal(f.calls.writes, 0)
        f.assertParentUnchanged()
      } finally { await bounded(f.manager.close(0)) }
    })
  }

  await check('子任务主流程失败不执行局部独立队列，也不改变主会话队列', async () => {
    const f = fixture()
    f.writeSkill('child-isolated', 'isolated')
    f.skillManager.loadAll()
    let rounds = 0
    let children = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
      if (messages[0].content.includes('LOCAL-SKILL-child-isolated')) { children++; yield { type: 'text', text: '不应运行' } }
      else if (++rounds === 1) yield { type: 'tool_call', id: 'queue-before-error', name: 'load_skill', arguments: { name: 'child-isolated' } }
      else yield { type: 'error', message: 'CHILD-PRIMARY-ERROR' }
      yield { type: 'done' }
    } }
    try {
      const result = await bounded(f.manager.spawn(f.request('defined'), { provider, registry: f.registry, ctx: f.ctx }))
      assert.equal(f.manager.getRecord(result.id)?.status, 'error')
      assert.equal(result.error, 'CHILD-PRIMARY-ERROR')
      assert.equal(children, 0)
      f.assertParentUnchanged()
    } finally { await bounded(f.manager.close(0)) }
  })

  for (const stage of ['execution', 'summary'] as const) {
    await check(`局部独立 Skill 的 ${stage} 失败保留在子任务报告，后续队列继续执行`, async () => {
      const f = fixture()
      for (const name of ['child-a', 'child-b']) f.writeSkill(name, 'isolated')
      f.skillManager.loadAll()
      const rounds = new Map<string, number>()
      const provider: Provider = { protocol: 'openai', async *streamChat(messages) {
        if (messages[0].content.startsWith('把下面的执行输出')) {
          if (stage === 'summary' && messages[1].content.includes('CHILD-A-OUTPUT')) yield { type: 'error', message: 'LOCAL-SUMMARY-ERROR' }
          else yield { type: 'text', text: 'CHILD-B-SUMMARY' }
        } else {
          const name = ['child-a', 'child-b'].find((name) => messages[0].content.includes(`LOCAL-SKILL-${name}`)) ?? 'primary'
          const round = (rounds.get(name) ?? 0) + 1
          rounds.set(name, round)
          if (name === 'primary' && round === 1) for (const name of ['child-a', 'child-b']) yield { type: 'tool_call', id: `load-${name}`, name: 'load_skill', arguments: { name } }
          else if (name === 'child-a' && stage === 'execution') yield { type: 'error', message: 'LOCAL-EXECUTION-ERROR' }
          else yield { type: 'text', text: name === 'child-a' ? 'CHILD-A-OUTPUT' : `${name} 完成` }
        }
        yield { type: 'done' }
      } }
      try {
        const record = await finish(f, f.request('defined'), provider)
        assert(record.result!.includes(stage === 'execution' ? 'LOCAL-EXECUTION-ERROR' : 'LOCAL-SUMMARY-ERROR'))
        assert(record.result!.includes('CHILD-B-SUMMARY'))
        assert.equal(rounds.get('child-a'), 1)
        assert.equal(rounds.get('child-b'), 1)
        f.assertParentUnchanged()
      } finally { await bounded(f.manager.close(0)) }
    })
  }

  await check('取消子任务独立 Skill 收尾会停止后续队列和摘要，主会话状态保持完整', async () => {
    const f = fixture()
    for (const name of ['child-a', 'child-b']) f.writeSkill(name, 'isolated')
    f.skillManager.loadAll()
    const started = deferred()
    const gate = deferred()
    let rounds = 0
    let summaries = 0
    let second = 0
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      if (messages[0].content.startsWith('把下面的执行输出')) { summaries++; yield { type: 'text', text: '不应摘要' } }
      else if (messages[0].content.includes('LOCAL-SKILL-child-a')) { started.resolve(); await resolveOnAbort(gate.promise, options.signal, undefined); yield { type: 'text', text: '迟到结果' } }
      else if (messages[0].content.includes('LOCAL-SKILL-child-b')) { second++; yield { type: 'text', text: '不应启动' } }
      else if (++rounds === 1) for (const name of ['child-a', 'child-b']) yield { type: 'tool_call', id: `queue-${name}`, name: 'load_skill', arguments: { name } }
      else yield { type: 'text', text: '子任务主流程完成' }
      yield { type: 'done' }
    } }
    try {
      const result = await f.manager.spawn({ ...f.request('defined'), async: true }, { provider, registry: f.registry, ctx: f.ctx })
      await bounded(started.promise)
      assert(f.manager.cancel(result.id))
      const finished = await bounded(f.manager.waitFor(result.id, 3000))
      assert.equal(finished.record?.status, 'cancelled')
      assert.equal(second, 0)
      assert.equal(summaries, 0)
      f.assertParentUnchanged()
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  await check('两个并发子任务加载不同 Skill，指令和工具限制互不污染', async () => {
    const f = fixture()
    f.writeSkill('task-a', 'shared', ['read_file'])
    f.writeSkill('task-b', 'shared', ['write_file'])
    f.skillManager.loadAll()
    const gate = deferred()
    let loads = 0
    const rounds = new Map<string, number>()
    const provider: Provider = { protocol: 'openai', async *streamChat(messages, options) {
      const name = messages.find((message) => message.role === 'user' && message.content.startsWith('task-'))!.content
      const round = (rounds.get(name) ?? 0) + 1
      rounds.set(name, round)
      if (round === 1) {
        yield { type: 'tool_call', id: `load-${name}`, name: 'load_skill', arguments: { name } }
        if (++loads === 2) gate.resolve()
        await gate.promise
      } else {
        assert(messages.some((message) => message.content.includes(`LOCAL-SKILL-${name}`)))
        assert(!messages.some((message) => message.content.includes(`LOCAL-SKILL-${name === 'task-a' ? 'task-b' : 'task-a'}`)))
        assert.deepEqual(options.tools!.map((tool) => tool.function.name).sort(), ['load_skill', name === 'task-a' ? 'read_file' : 'write_file'])
        yield { type: 'text', text: `${name} 完成` }
      }
      yield { type: 'done' }
    } }
    try {
      const results = await bounded(Promise.all(['task-a', 'task-b'].map((name) => finish(f, { ...f.request('defined', name), async: true }, provider))))
      assert(results.every((record) => record.status === 'done'))
      f.assertParentUnchanged()
    } finally { gate.resolve(); await bounded(f.manager.close(0)) }
  })

  for (const parentLock of [false, true]) {
    await check(`worktree 写入围栏拒绝父文件及命令，父围栏${parentLock ? '已配置' : '未配置'}`, async () => {
      const f = fixture({ worktree: true })
      const parentFile = join(f.directory, 'parent.txt')
      const commandFile = join(f.directory, 'command-escape.txt')
      writeFileSync(parentFile, 'PARENT-ORIGINAL')
      if (parentLock) f.ctx.rootLock = f.directory
      f.registry = new ToolRegistry()
      for (const tool of [readFileTool, writeFileTool, editFileTool, runCommandTool]) f.registry.register(tool)
      let rounds = 0
      const provider: Provider = { protocol: 'openai', async *streamChat() {
        if (++rounds === 1) {
          yield { type: 'tool_call', id: 'write-parent', name: 'write_file', arguments: { path: parentFile, content: 'PARENT-CORRUPTED' } }
          yield { type: 'tool_call', id: 'edit-parent', name: 'edit_file', arguments: { path: parentFile, old_text: 'PARENT-ORIGINAL', new_text: 'PARENT-EDITED' } }
          yield { type: 'tool_call', id: 'command-parent', name: 'run_command', arguments: { command: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(commandFile)},'ESCAPED')`] } }
          yield { type: 'tool_call', id: 'write-child', name: 'write_file', arguments: { path: 'child.txt', content: 'CHILD-WRITTEN' } }
          yield { type: 'tool_call', id: 'read-parent', name: 'read_file', arguments: { path: parentFile } }
        } else yield { type: 'text', text: 'worktree 检查完成' }
        yield { type: 'done' }
      } }
      try {
        const record = await finish(f, f.request('defined'), provider)
        assert.equal(readFileSync(parentFile, 'utf8'), 'PARENT-ORIGINAL')
        assert(!existsSync(commandFile))
        assert.equal(readFileSync(join(f.worktreePath, 'child.txt'), 'utf8'), 'CHILD-WRITTEN')
        assert(record.result!.includes('PARENT-ORIGINAL'))
        assert.equal(f.ctx.rootLock, parentLock ? f.directory : undefined)
      } finally { await bounded(f.manager.close(0)) }
    })
  }

  await check('worktree 保留显式共享产物目录，并按父工作目录解析角色 write_paths', async () => {
    const f = fixture({ worktree: true, contract: true })
    const shared = join(f.directory, 'shared')
    const report = join(f.directory, '.reports')
    const parentFile = join(f.directory, 'blocked.txt')
    f.ctx.rootLock = f.directory
    f.ctx.rootLockExtra = [shared]
    f.registry = new ToolRegistry()
    f.registry.register(writeFileTool)
    let rounds = 0
    const provider: Provider = { protocol: 'openai', async *streamChat() {
      if (++rounds === 1) for (const [id, path] of [['parent', parentFile], ['shared', join(shared, 'result.txt')], ['contract', join(report, 'result.txt')]]) {
        yield { type: 'tool_call', id, name: 'write_file', arguments: { path, content: id } }
      }
      else yield { type: 'text', text: '契约产物完成' }
      yield { type: 'done' }
    } }
    try {
      await finish(f, f.request('defined'), provider)
      assert(!existsSync(parentFile))
      assert.equal(readFileSync(join(shared, 'result.txt'), 'utf8'), 'shared')
      assert.equal(readFileSync(join(report, 'result.txt'), 'utf8'), 'contract')
      assert.deepEqual(f.ctx.rootLockExtra, [shared])
    } finally { await bounded(f.manager.close(0)) }
  })
} finally {
  const target = resolve(root)
  assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_subagent_scope_'))
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
