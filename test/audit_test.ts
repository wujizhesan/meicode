// 审计修复回归测试：围栏/黑名单/spill/sanitize 的关键场景
import { guardCommand, guardPath } from '../src/tools/types.ts'
import { matchBlacklist } from '../src/permission/blacklist.ts'
import { spillBatch, SPILL_THRESHOLD } from '../src/context/spill.ts'
import { sanitizeMessages } from '../src/memory/session.ts'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}: ${(e as Error).message}`)
  }
}

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg)
}

// ---------- guardCommand 围栏 ----------
const GCTX = { cwd: 'D:/x/wt', rootLock: 'D:/x/wt' }
await check('围栏: 基础穿越拦截', () => {
  assert(guardCommand(GCTX, 'cd ..\\..\\x') !== null, 'cd .. 未拦')
  assert(guardCommand(GCTX, 'cd ..; dir') !== null, 'cd ..; 未拦')
})
await check('围栏: .\\.. 前缀绕过已堵', () => {
  assert(guardCommand(GCTX, 'cd .\\..\\..\\Users\\evil') !== null, '.\\.. 未拦')
  assert(guardCommand(GCTX, 'echo x > .\\..\\..\\repo\\f.js') !== null, '重定向 .\\.. 未拦')
})
await check('围栏: 省略号/中缀不误杀', () => {
  assert(guardCommand(GCTX, 'echo hello...') === null, '句尾省略号误杀')
  assert(guardCommand(GCTX, 'a..b && dir') === null, '点中缀误杀')
  assert(guardCommand(GCTX, 'dir /s') === null, '普通命令误杀')
})
await check('围栏: 界内相对路径放行', () => {
  assert(guardCommand(GCTX, 'cd sub\\dir && npm test') === null, '界内相对误杀')
})
await check('guardPath: 只读输入豁免外部/写路径仍拦(实战:dd_extract 读外部目标)', () => {
  const GCTX_EXTRA = { cwd: 'D:/x/wt', rootLock: 'D:/x/wt', rootLockExtra: ['D:/reverse-notes'] }
  assert(guardPath(GCTX_EXTRA, 'D:/tmpnpm-global/node_modules/x.js', false) === null, '只读输入应放行')
  assert(guardPath(GCTX_EXTRA, 'D:/tmpnpm-global/node_modules/x.js') !== null, '写路径应拦')
  assert(guardPath(GCTX_EXTRA, 'D:/reverse-notes/report.md') === null, '契约目录应放行')
  assert(guardPath(GCTX_EXTRA, 'D:/x/wt/inside.js') === null, '界内应放行')
})
await check('围栏: 只读白名单新命令放行(实战:recon 读外部目标)', () => {
  for (const c of [
    'head -50 D:/tmpnpm-global/node_modules/cycletls/dist/index.js',
    'tail -20 D:\\tmpnpm-global\\node_modules\\cycletls\\dist\\index.js',
    'wc -c D:/tmpnpm-global/node_modules/cycletls/dist/index.exe',
    'strings D:/tmpnpm-global/node_modules/cycletls/dist/index.exe',
    'file D:/tmpnpm-global/node_modules/cycletls/dist/index.exe',
    'grep -n "JA3" D:/tmpnpm-global/node_modules/cycletls/dist/index.js',
    'cat D:/tmpnpm-global/node_modules/cycletls/package.json',
    'head -30 D:/tmpnpm-global/node_modules/cycletls/package.json | grep version',
    'findstr /n formhash D:/tmpnpm-global/node_modules/cycletls/dist/index.js',
    'more D:/tmpnpm-global/node_modules/cycletls/dist/index.js',
  ]) {
    assert(guardCommand(GCTX, c) === null, `只读命令被误拦: ${c}`)
  }
})
await check('围栏: 危险命令带外部路径仍拦(围栏职责=路径,执行管控是黑名单)', () => {
  for (const c of [
    'node -e "require(\'D:/tmpnpm-global/node_modules/cycletls\')"',
    'sed -i s/x/y/g D:/tmpnpm-global/node_modules/cycletls/dist/index.js',
    'find D:/tmpnpm-global -name "*.js" -delete',
    'python -c "open(\'D:/tmpnpm-global/x\')"',
  ]) {
    assert(guardCommand(GCTX, c) !== null, `危险命令被放行: ${c}`)
  }
})
await check('围栏: 无 rootLock 不受限', () => {
  assert(guardCommand({ cwd: 'D:/x' }, 'cd ..') === null, '无锁时误拦')
})

// ---------- 黑名单 ----------
await check('黑名单: 拆 args 绕过已堵', () => {
  assert(matchBlacklist('shutdown /s /f /t 0').matched, 'shutdown 内联未拦')
  assert(matchBlacklist('shutdown /s').matched, 'shutdown 拆开未拦')
  assert(matchBlacklist('format /q A:').matched, 'format 未拦')
  assert(matchBlacklist('del /s /q C:\\x').matched, 'del 未拦')
})
await check('黑名单: 普通命令放行', () => {
  assert(!matchBlacklist('dir').matched, 'dir 误拦')
  assert(!matchBlacklist('npm install').matched, 'npm 误拦')
})

// ---------- spill 单条阈值 ----------
await check('spill: 单条超阈值(合计未超)也存盘', async () => {
  const TMP = join(process.cwd(), '.tmp-audit-spill')
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const big = 'x'.repeat(SPILL_THRESHOLD + 100) // 单条 >4KB
  const out = await spillBatch([{ content: big }, { content: 'small' }], TMP)
  assert(out[0].content.startsWith('[已存盘]'), '大条未存盘')
  assert(out[1].content === 'small', '小条被误动')
  rmSync(TMP, { recursive: true, force: true })
})
await check('spill: 全部小条不动', async () => {
  const TMP = join(process.cwd(), '.tmp-audit-spill2')
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const out = await spillBatch([{ content: 'a' }, { content: 'b' }], TMP)
  assert(out[0].content === 'a' && out[1].content === 'b', '小条被误动')
  rmSync(TMP, { recursive: true, force: true })
})

// ---------- sanitize 紧邻性 ----------
const A = (id: string): ReturnType<typeof Object.assign> => ({ role: 'assistant', content: '', tool_calls: [{ id, name: 'x', arguments: '{}' }] })
const T = (id: string): ReturnType<typeof Object.assign> => ({ role: 'tool', tool_call_id: id, content: 'ok' })
const S = (c: string): ReturnType<typeof Object.assign> => ({ role: 'system', content: c })

await check('sanitize: 中间插 system 弹回（400 根因场景）', () => {
  const out = sanitizeMessages([A('t1'), S('插队'), T('t1')])
  assert(out.length === 1 && out[0].role === 'system', `应只剩 system,实际 ${JSON.stringify(out.map((m) => m.role))}`)
})
await check('sanitize: 交错序列保留下一个完整轮', () => {
  const out = sanitizeMessages([A('t1'), A('t2'), T('t1'), T('t2')])
  assert(out.length === 2 && out[0].role === 'assistant' && out[1].role === 'tool', '交错处理错')
})
await check('sanitize: 缺失配对弹回', () => {
  const out = sanitizeMessages([A('t1'), A('t2'), T('t1')])
  assert(out.length === 0, `缺失配对应全弹,实际 ${out.length}`)
})
await check('sanitize: 正常序列保留', () => {
  const out = sanitizeMessages([A('t1'), T('t1')])
  assert(out.length === 2, '正常序列被误删')
})

console.log(`\naudit_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
