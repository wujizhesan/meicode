// 命令系统测试：注册/解析/分发/补全/十命令
import { CommandRegistry, parseCommandLine, BUILTIN_COMMANDS, createDispatcher } from '../src/commands/index.ts'
import type { CommandDef, UiController } from '../src/commands/index.ts'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}

// mock UiController：记录调用
function makeMockUi() {
  const calls: { method: string; args: unknown[] }[] = []
  const ui: UiController = {
    showMessage: (t) => calls.push({ method: 'showMessage', args: [t] }),
    sendUserMessage: (t) => calls.push({ method: 'sendUserMessage', args: [t] }),
    setMode: (m) => calls.push({ method: 'setMode', args: [m] }),
    clearHistory: () => calls.push({ method: 'clearHistory', args: [] }),
    compact: async () => {
      calls.push({ method: 'compact', args: [] })
      return '压缩完成'
    },
    sessionAction: (a, arg) => {
      calls.push({ method: 'sessionAction', args: [a, arg] })
      return `action:${a}`
    },
    snapshotAction: async (a, arg) => {
      calls.push({ method: 'snapshotAction', args: [a, arg] })
      return `action:${a}`
    },
    memoryList: () => {
      calls.push({ method: 'memoryList', args: [] })
      return '暂无笔记'
    },
    permissionSummary: () => {
      calls.push({ method: 'permissionSummary', args: [] })
      return 'mode: default'
    },
    getStatus: () => {
      calls.push({ method: 'getStatus', args: [] })
      return 'status-ok'
    },
    listCommands: (h) => {
      calls.push({ method: 'listCommands', args: [h] })
      return []
    },
    skillList: () => {
      calls.push({ method: 'skillList', args: [] })
      return '- commit: 提交变更'
    },
    skillActivate: (n) => {
      calls.push({ method: 'skillActivate', args: [n] })
      return `已激活: ${n}`
    },
    skillDeactivate: (n) => {
      calls.push({ method: 'skillDeactivate', args: [n] })
      return `已停用: ${n}`
    },
    teamAction: (a, args) => {
      calls.push({ method: 'teamAction', args: [a, args] })
      return `team:${a}`
    },
    workflowAction: (a, args) => {
      calls.push({ method: 'workflowAction', args: [a, args] })
      return `wf:${a}`
    },
  }
  return { ui, calls }
}

function makeRegistry(): CommandRegistry {
  const r = new CommandRegistry()
  for (const c of BUILTIN_COMMANDS) r.register(c)
  return r
}

async function main() {
  // ---------- 注册中心 ----------
  await check('注册: 十二命令登记齐全', () => {
    const r = makeRegistry()
    if (r.list().length !== 16) throw new Error(`数量 ${r.list().length}`)
  })
  await check('注册: 别名冲突抛错', () => {
    const r = makeRegistry()
    const dup: CommandDef = {
      name: 'dup',
      aliases: ['compact'], // 与已有 /compact 冲突
      description: 'x',
      usage: '/dup',
      type: 'local',
      handler: () => {},
    }
    let threw = false
    try {
      r.register(dup)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('别名冲突未抛错')
  })
  await check('注册: find 别名与大小写', () => {
    const r = makeRegistry()
    if (!r.find('SESSION') || !r.find('resume')) throw new Error('find 失败')
    if (r.find('nope')) throw new Error('未命中不应找到')
  })

  // ---------- 解析器 ----------
  await check('解析: 大写/参数/空/非命令', () => {
    const p1 = parseCommandLine('/HELP x y')
    if (!p1 || p1.name !== 'help' || p1.args.join(',') !== 'x,y') throw new Error(`p1: ${JSON.stringify(p1)}`)
    if (parseCommandLine('/') !== null) throw new Error('纯斜杠应 null')
    if (parseCommandLine('你好') !== null) throw new Error('非命令应 null')
    if (parseCommandLine('') !== null) throw new Error('空应 null')
    const p2 = parseCommandLine('/compact')
    if (!p2 || p2.args.length !== 0) throw new Error(`p2: ${JSON.stringify(p2)}`)
  })

  // ---------- 分发 ----------
  await check('分发: local 命令零 send', async () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    const handled = d.dispatch('/status')
    if (!handled) throw new Error('应处理')
    if (calls.some((c) => c.method === 'sendUserMessage')) throw new Error('local 不应 send')
    if (!calls.some((c) => c.method === 'getStatus')) throw new Error('应调 getStatus')
  })
  await check('分发: prompt 命令触发一次 send', async () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/review')
    const sends = calls.filter((c) => c.method === 'sendUserMessage')
    if (sends.length !== 1) throw new Error(`send 次数 ${sends.length}`)
    if (!String(sends[0].args[0]).includes('git')) throw new Error('应含 git 审查提示')
  })
  await check('分发: 非命令返回 false', () => {
    const { ui } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    if (d.dispatch('你好') !== false) throw new Error('非命令应 false')
  })
  await check('分发: 未知命令 /help 引导', () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/xyz')
    const msg = calls.find((c) => c.method === 'showMessage')?.args[0] as string
    if (!msg.includes('/help')) throw new Error(`引导缺失: ${msg}`)
  })
  await check('分发: /clear → clearHistory', () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/clear')
    if (!calls.some((c) => c.method === 'clearHistory')) throw new Error('未调 clearHistory')
  })
  await check('分发: /plan 带任务 → setMode + send', () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/plan 分析 src')
    if (!calls.some((c) => c.method === 'setMode' && c.args[0] === 'plan')) throw new Error('未切模式')
    if (!calls.some((c) => c.method === 'sendUserMessage' && c.args[0] === '分析 src')) throw new Error('未发送任务')
  })
  await check('分发: /do → setMode(default)', () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/do')
    if (!calls.some((c) => c.method === 'setMode' && c.args[0] === 'default')) throw new Error('未回 default')
  })
  await check('分发: /skill 列表与激活', () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/skill')
    if (!calls.some((c) => c.method === 'skillList')) throw new Error('未调 skillList')
    d.dispatch('/skill commit')
    if (!calls.some((c) => c.method === 'skillActivate' && c.args[0] === 'commit')) throw new Error('未调 skillActivate')
    d.dispatch('/skill off commit')
    if (!calls.some((c) => c.method === 'skillDeactivate' && c.args[0] === 'commit')) throw new Error('未调 skillDeactivate')
  })
  await check('分发: /session 与 /resume 别名', () => {
    const { ui, calls } = makeMockUi()
    const d = createDispatcher(makeRegistry(), ui)
    d.dispatch('/resume 20260809-1')
    if (!calls.some((c) => c.method === 'sessionAction' && c.args[0] === 'resume' && c.args[1] === '20260809-1')) {
      throw new Error('resume 别名未生效')
    }
  })

  // ---------- 补全 ----------
  await check('补全: 单匹配直接补', () => {
    const r = makeRegistry()
    const c = r.complete('/sess')
    if (c.length !== 1 || c[0] !== 'session') throw new Error(`补全: ${JSON.stringify(c)}`)
  })
  await check('补全: 多匹配', () => {
    const r = makeRegistry()
    const c = r.complete('/m')
    if (c.length < 2 || !c.includes('memory') || !c.includes('mode')) throw new Error(`补全: ${JSON.stringify(c)}`)
  })
  await check('补全: 大小写不敏感', () => {
    const r = makeRegistry()
    const c = r.complete('/COMP')
    if (!c.includes('compact')) throw new Error(`补全: ${JSON.stringify(c)}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('commands 测试异常:', e)
  process.exit(1)
})
