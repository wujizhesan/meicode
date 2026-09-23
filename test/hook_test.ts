// Hook 系统测试：匹配/加载/引擎/拦截/执行控制/失败隔离
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { matchPattern, matchCondition, loadHooks, HookEngine, setSubagentSpawner } from '../src/hook/index.ts'
import type { HookRule } from '../src/hook/index.ts'

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

const TMP = join(import.meta.dirname, 'fixtures_hook')
try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 占用时忽略 */ }
mkdirSync(TMP, { recursive: true })

function rule(partial: Partial<HookRule> & { event: HookRule['event'] }): HookRule {
  return {
    event: partial.event,
    ...(partial.if ? { if: partial.if } : {}),
    action: partial.action ?? { type: 'command', command: 'echo hi' },
    ...(partial.once ? { once: true } : {}),
    ...(partial.async ? { async: true } : {}),
  }
}

async function main() {
  // ---------- 匹配器 ----------
  await check('匹配: 精确/反向/正则/glob', () => {
    if (!matchPattern('rm -rf /', 'rm -rf /')) throw new Error('精确失败')
    if (matchPattern('git status', '!git *')) throw new Error('反向失败')
    if (!matchPattern('call_123', '/call_\\d+/')) throw new Error('正则失败')
    if (matchPattern('abc', '/[0-9]+/')) throw new Error('正则误匹配')
    if (!matchPattern('src/index.ts', 'src/**')) throw new Error('glob 失败')
    if (!matchPattern('anything', '!nope')) throw new Error('反向基本')
  })
  await check('匹配: all/any 与深层取值', () => {
    const data = { name: 'run_command', args: { command: 'git status' } }
    if (!matchCondition(data, { all: [{ match: 'name', pattern: 'run_command' }, { match: 'args.command', pattern: 'git *' }] })) {
      throw new Error('all 失败')
    }
    if (matchCondition(data, { all: [{ match: 'name', pattern: 'read_file' }, { match: 'args.command', pattern: 'git *' }] })) {
      throw new Error('all 应全真')
    }
    if (!matchCondition(data, { any: [{ match: 'name', pattern: 'read_file' }, { match: 'args.command', pattern: 'git *' }] })) {
      throw new Error('any 失败')
    }
    if (!matchCondition(data, {})) throw new Error('空条件应真')
  })

  // ---------- 加载器 ----------
  await check('加载: 合法规则与坏规则跳过', () => {
    const hookFile = join(TMP, '.mewcode', 'hooks.yaml')
    mkdirSync(join(TMP, '.mewcode'), { recursive: true })
    writeFileSync(
      hookFile,
      `hooks:
  - event: round_start
    action:
      type: inject_prompt
      content: 优先检查测试
  - event: tool_before
    if:
      all:
        - match: name
          pattern: run_command
    action:
      type: command
      command: echo blocked
  - event: bad_event
    action:
      type: command
      command: x
  - event: tool_before
    action:
      type: command
      command: x
    async: true
`,
      'utf8',
    )
    const { rules, skipped } = loadHooks(TMP)
    if (rules.length !== 2) throw new Error(`规则数 ${rules.length}，期望 2`)
    if (skipped !== 2) throw new Error(`跳过数 ${skipped}，期望 2（坏事件 + tool_before async）`)
  })
  await check('加载: 扩展事件清单全部可用', () => {
    const root = join(TMP, 'extended-events')
    mkdirSync(join(root, '.mewcode'), { recursive: true })
    const events = ['permission_request', 'permission_denied', 'subagent_start', 'subagent_stop', 'pre_compact', 'post_compact', 'task_created', 'task_completed', 'teammate_idle']
    writeFileSync(join(root, '.mewcode', 'hooks.yaml'), `hooks:\n${events.map((event) => `  - event: ${event}\n    action:\n      type: inject_prompt\n      content: ${event}`).join('\n')}\n`, 'utf8')
    const loaded = loadHooks(root)
    if (loaded.skipped !== 0 || loaded.rules.length !== events.length) {
      throw new Error(`扩展事件加载错误: ${loaded.rules.length}/${loaded.skipped}`)
    }
  })

  // ---------- 引擎 ----------
  await check('引擎: 事件触发与 once', async () => {
    let count = 0
    const engine = new HookEngine([
      rule({ event: 'round_start', once: true, action: { type: 'command', command: 'node -e ""' } }),
    ])
    // 用 inject 检测：once 后第二次不注入
    const injEngine = new HookEngine([
      rule({ event: 'round_start', once: true, action: { type: 'inject_prompt', content: '仅一次' } }),
    ])
    await injEngine.fire('round_start', { cwd: TMP })
    await injEngine.fire('round_start', { cwd: TMP })
    if (injEngine.collectInjections().length !== 1) throw new Error(`once 未生效: ${injEngine.collectInjections().length}`)
    void count
  })
  await check('引擎: inject_prompt 缓冲与 resetRound', async () => {
    const engine = new HookEngine([rule({ event: 'round_start', action: { type: 'inject_prompt', content: '提示A' } })])
    await engine.fire('round_start', { cwd: TMP })
    const inj = engine.collectInjections()
    if (inj.length !== 1 || inj[0] !== '提示A') throw new Error('注入缓冲失败')
    if (engine.collectInjections().length !== 0) throw new Error('注入被重复投递')
    engine.resetRound()
    if (engine.collectInjections().length !== 0) throw new Error('resetRound 失败')
  })
  await check('引擎: 慢命令不延迟 prompt 注入', async () => {
    const slowCommand = process.platform === 'win32'
      ? 'ping -n 2 127.0.0.1 >nul'
      : 'node -e "setTimeout(function(){}, 200)"'
    const engine = new HookEngine([
      rule({ event: 'subagent_start', action: { type: 'command', command: slowCommand } }),
      rule({ event: 'subagent_start', action: { type: 'inject_prompt', content: '立即注入' } }),
    ])
    const pending = engine.fire('subagent_start', { cwd: TMP, sessionId: 'session-fast', agentId: 'child' })
    const immediate = engine.collectInjections({ sessionId: 'session-fast', agentId: 'child' })
    await pending
    if (immediate.join(',') !== '立即注入') throw new Error('prompt 注入被前置慢命令延迟')
  })
  await check('引擎: 子任务结束注入路由到父 Agent', async () => {
    const engine = new HookEngine([rule({ event: 'subagent_stop', action: { type: 'inject_prompt', content: '子任务已完成' } })])
    await engine.fire('subagent_stop', {
      cwd: TMP,
      sessionId: 'session-route',
      agentId: 'child-agent',
      targetAgentId: 'parent-agent',
    })
    if (engine.collectInjections({ sessionId: 'session-route', agentId: 'child-agent' }).length !== 0) {
      throw new Error('结束注入仍投递给已退出的子 Agent')
    }
    if (engine.collectInjections({ sessionId: 'session-route', agentId: 'parent-agent' }).join(',') !== '子任务已完成') {
      throw new Error('结束注入未投递给父 Agent')
    }
  })
  await check('引擎: 会话结束清理遗留注入', async () => {
    const engine = new HookEngine([rule({ event: 'round_end', action: { type: 'inject_prompt', content: '遗留提示' } })])
    await engine.fire('round_end', { cwd: TMP, sessionId: 'session-clear', agentId: 'agent-clear' })
    engine.clearSession('session-clear')
    if (engine.collectInjections({ sessionId: 'session-clear', agentId: 'agent-clear' }).length !== 0) throw new Error('会话注入未清理')
  })
  await check('引擎: sessionId 可用于会话条件匹配', async () => {
    const engine = new HookEngine([
      rule({
        event: 'session_start',
        if: { all: [{ match: 'sessionId', pattern: 'session-target' }] },
        action: { type: 'inject_prompt', content: 'session matched' },
      }),
    ])
    await engine.fire('session_start', { cwd: TMP, sessionId: 'session-other' })
    await engine.fire('session_start', { cwd: TMP, sessionId: 'session-target' })
    if (engine.collectInjections({ sessionId: 'session-target' }).join(',') !== 'session matched') throw new Error('sessionId 未进入 Hook 匹配上下文')
  })
  await check('引擎: 注入按会话和 Agent 隔离', async () => {
    const engine = new HookEngine([rule({ event: 'round_start', action: { type: 'inject_prompt', content: 'agent-a-only' } })])
    const agentA = { sessionId: 'session-1', agentId: 'agent-a' }
    const agentB = { sessionId: 'session-1', agentId: 'agent-b' }
    await engine.fire('round_start', { cwd: TMP, ...agentA })
    if (engine.collectInjections(agentB).length !== 0) throw new Error('Agent A 注入泄漏到 Agent B')
    engine.resetRound(agentB)
    if (engine.collectInjections(agentA).join(',') !== 'agent-a-only') throw new Error('Agent B reset 清除了 Agent A 注入')
  })
  await check('引擎: agentId 与 stats 可参与条件匹配', async () => {
    const engine = new HookEngine([rule({
      event: 'subagent_stop',
      if: { all: [{ match: 'agentId', pattern: 'agent-target' }, { match: 'stats', pattern: '*status=done*' }] },
      action: { type: 'inject_prompt', content: 'context matched' },
    })])
    await engine.fire('subagent_stop', { cwd: TMP, sessionId: 'session-1', agentId: 'agent-target', stats: 'status=done tokens=1' })
    if (engine.collectInjections({ sessionId: 'session-1', agentId: 'agent-target' }).join(',') !== 'context matched') {
      throw new Error('新增 Hook 上下文字段未进入条件匹配')
    }
  })
  await check('引擎: intercept 命中与未命中', async () => {
    const engine = new HookEngine([
      rule({
        event: 'tool_before',
        if: { all: [{ match: 'name', pattern: 'run_command' }, { match: 'args.command', pattern: 'rm *' }] },
        action: { type: 'command', command: 'echo blocked' },
      }),
    ])
    const blocked = await engine.intercept({ name: 'run_command', args: { command: 'rm -rf /' } }, TMP)
    if (!blocked || !blocked.includes('[Hook 拦截]')) throw new Error(`未拦截: ${blocked}`)
    const ok = await engine.intercept({ name: 'read_file', args: { path: 'x' } }, TMP)
    if (ok !== null) throw new Error(`不应拦截: ${ok}`)
  })
  await check('引擎: intercept 保留会话上下文', async () => {
    const engine = new HookEngine([
      rule({
        event: 'tool_before',
        if: { all: [{ match: 'sessionId', pattern: 'session-target' }, { match: 'name', pattern: 'run_command' }] },
        action: { type: 'command', command: 'echo blocked' },
      }),
    ])
    const other = await engine.intercept({ name: 'run_command', args: { command: 'echo ok' } }, { cwd: TMP, sessionId: 'session-other' })
    const target = await engine.intercept({ name: 'run_command', args: { command: 'echo ok' } }, { cwd: TMP, sessionId: 'session-target' })
    if (other !== null || !target) throw new Error('tool_before 未按 sessionId 隔离')
  })
  await check('引擎: http 动作发出', async () => {
    let received = false
    const server = http.createServer((req, res) => {
      received = true
      res.writeHead(200)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as AddressInfo).port
    const engine = new HookEngine([
      rule({ event: 'tool_after', action: { type: 'http', url: `http://127.0.0.1:${port}/hook`, body: 'x' } }),
    ])
    await engine.fire('tool_after', { cwd: TMP, call: { name: 'read_file', args: {} } })
    await new Promise((r) => setTimeout(r, 300))
    server.close()
    if (!received) throw new Error('HTTP 未收到')
  })
  await check('引擎: subagent 占位不抛', async () => {
    const engine = new HookEngine([rule({ event: 'round_end', action: { type: 'subagent', name: 'test' } })])
    await engine.fire('round_end', { cwd: TMP }) // 不应抛
  })
  await check('引擎: async 规则拒绝被捕获', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      setSubagentSpawner(() => { throw new Error('async hook failed') })
      const engine = new HookEngine([rule({ event: 'round_end', async: true, action: { type: 'subagent', name: 'broken' } })])
      await engine.fire('round_end', { cwd: TMP })
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      setSubagentSpawner(() => {})
      console.warn = originalWarn
    }
    if (!warnings.some((message) => message.includes('异步规则执行失败') && message.includes('async hook failed'))) {
      throw new Error('async Hook 拒绝未被记录')
    }
  })
  await check('引擎: 失败隔离——坏命令不中断', async () => {
    const engine = new HookEngine([
      rule({ event: 'round_start', action: { type: 'command', command: 'no_such_cmd_xyz_123' } }),
      rule({ event: 'round_start', action: { type: 'inject_prompt', content: '第二条仍执行' } }),
    ])
    await engine.fire('round_start', { cwd: TMP })
    const inj = engine.collectInjections()
    if (!inj.includes('第二条仍执行')) throw new Error('失败后后续规则未执行')
  })
  await check('引擎: 命令超时被杀', async () => {
    const engine = new HookEngine([
      rule({ event: 'round_start', action: { type: 'command', command: 'ping -n 100 127.0.0.1', timeout: 500 } }),
    ])
    const t0 = Date.now()
    await engine.fire('round_start', { cwd: TMP })
    const elapsed = Date.now() - t0
    if (elapsed > 3000) throw new Error(`超时未生效: ${elapsed}ms`)
  })

  // ---------- 新事件补全 ----------
  await check('新事件: permission_request/denied 触发与参数', async () => {
    const logFile = join(TMP, 'perm.log')
    const engine = new HookEngine([
      { event: 'permission_denied', action: { type: 'command', command: `echo denied:${'${hook.call.name}'} >> ${logFile}` } },
    ])
    await engine.fire('permission_denied', { cwd: TMP, call: { name: 'run_command', args: {} }, decision: 'deny', reason: '黑名单拦截' })
    if (!existsSync(logFile)) throw new Error('permission_denied hook 未执行')
    if (!readFileSync(logFile, 'utf8').includes('run_command')) throw new Error('hook 参数缺失')
    rmSync(logFile, { force: true })
  })

  await check('新事件: subagent_start/stop 触发与 stats', async () => {
    const logFile = join(TMP, 'sub.log')
    const engine = new HookEngine([
      { event: 'subagent_stop', action: { type: 'command', command: `echo stop:${'${hook.agentId}'}:${'${hook.stats}'} >> ${logFile}` } },
    ])
    await engine.fire('subagent_stop', { cwd: TMP, agentId: 'sub-abc', role: 'code-reviewer', stats: 'status=done tokens=100 duration=1.2s' })
    if (!existsSync(logFile)) throw new Error('subagent_stop hook 未执行')
    const content = readFileSync(logFile, 'utf8')
    if (!content.includes('sub-abc') || !content.includes('duration=1.2s')) throw new Error(`stats 缺失: ${content}`)
    rmSync(logFile, { force: true })
  })

  await check('新事件: pre/post_compact 触发', async () => {
    const logFile = join(TMP, 'cmp.log')
    const engine = new HookEngine([
      { event: 'pre_compact', action: { type: 'command', command: `echo pre >> ${logFile}` } },
      { event: 'post_compact', action: { type: 'command', command: `echo post >> ${logFile}` } },
    ])
    await engine.fire('pre_compact', { cwd: TMP, stats: 'drop=10msgs' })
    await engine.fire('post_compact', { cwd: TMP, stats: 'dropped=10msgs → summary=200chars' })
    if (!existsSync(logFile)) throw new Error('compact hook 未执行')
    if (!readFileSync(logFile, 'utf8').includes('post')) throw new Error('post_compact 缺失')
    rmSync(logFile, { force: true })
  })

  await check('命令模板: Hook 字段不能注入额外 shell 命令', async () => {
    const marker = join(TMP, 'shell-injected.txt')
    const payload = process.platform === 'win32'
      ? `safe&echo injected>${marker}`
      : `safe; printf injected > ${marker}`
    const engine = new HookEngine([
      { event: 'tool_after', action: { type: 'command', command: `echo ${'${hook.call.args.path}'}` } },
    ])
    await engine.fire('tool_after', { cwd: TMP, call: { name: 'read_file', args: { path: payload } } })
    if (existsSync(marker)) throw new Error('Hook 字段触发了额外 shell 命令')
  })

  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('hook 测试异常:', e)
  process.exit(1)
})
