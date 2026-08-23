// 工具层冒烟：registry + 六工具直调
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'

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

const TMP = join(import.meta.dirname, 'fixtures_tools')
mkdirSync(TMP, { recursive: true })

const ctx: ToolContext = { cwd: TMP, timeoutMs: 2000 }

async function main() {
  const tools = createTools(ctx)
  const registry = new ToolRegistry()
  tools.forEach((t) => registry.register(t))

  // ---------- registry ----------
  await check('registry: 十六工具登记齐全', () => {
    if (registry.list().length !== 12) throw new Error(`数量 ${registry.list().length}`)
  })
  await check('registry: 按名查找', () => {
    if (!registry.get('read_file') || registry.get('nope')) throw new Error('get 失败')
  })
  await check('registry: toOpenAITools 格式', () => {
    const openai = registry.toOpenAITools()
    const t = openai[0]
    if (t.type !== 'function' || !t.function.name || !t.function.description || !t.function.parameters) {
      throw new Error(`格式不符: ${JSON.stringify(t).slice(0, 120)}`)
    }
  })
  await check('registry: 重名抛错', () => {
    try {
      registry.register(registry.get('read_file')!)
      throw new Error('未抛错')
    } catch (e) {
      if (!(e as Error).message.includes('重名')) throw e
    }
  })

  // ---------- write_file ----------
  await check('write_file: 写入返回字节数', async () => {
    const r = await tools[1].execute({ path: 'a.txt', content: 'hello 世界' }, ctx)
    if (!r.success) throw new Error(r.error)
    if (!r.output.includes('12')) throw new Error(`字节数不符: ${r.output}`)
  })
  await check('write_file: 嵌套目录自动创建', async () => {
    const r = await tools[1].execute({ path: 'nested/deep/b.txt', content: 'x' }, ctx)
    if (!r.success || !existsSync(join(TMP, 'nested/deep/b.txt'))) throw new Error(r.error ?? '文件未创建')
  })

  // ---------- read_file ----------
  await check('read_file: 读回一致', async () => {
    const r = await tools[0].execute({ path: 'a.txt' }, ctx)
    if (!r.success || r.output !== 'hello 世界') throw new Error(`内容不符: ${r.output}`)
  })
  await check('read_file: 不存在文件 → 结构化错误', async () => {
    const r = await tools[0].execute({ path: 'missing.txt' }, ctx)
    if (r.success || !r.error?.includes('读取失败')) throw new Error(`应失败: ${JSON.stringify(r)}`)
  })
  await check('read_file: 绝对路径', async () => {
    const r = await tools[0].execute({ path: join(TMP, 'a.txt') }, ctx)
    if (!r.success || r.output !== 'hello 世界') throw new Error('绝对路径失败')
  })

  // ---------- edit_file ----------
  writeFileSync(join(TMP, 'edit.txt'), 'line1\nTARGET line2\nline3\n', 'utf8')
  await check('edit_file: 唯一匹配替换', async () => {
    const r = await tools[2].execute({ path: 'edit.txt', old_text: 'TARGET', new_text: 'CHANGED' }, ctx)
    if (!r.success) throw new Error(r.error)
    const content = readFileSync(join(TMP, 'edit.txt'), 'utf8')
    if (!content.includes('CHANGED') || content.includes('TARGET')) throw new Error('替换结果不符')
  })
  await check('edit_file: 零匹配报错', async () => {
    const r = await tools[2].execute({ path: 'edit.txt', old_text: 'NO_SUCH_TEXT', new_text: 'x' }, ctx)
    if (r.success || !r.error!.includes('未找到')) throw new Error(`应报未找到: ${JSON.stringify(r)}`)
  })
  writeFileSync(join(TMP, 'edit2.txt'), 'DUP\nDUP\nend\n', 'utf8')
  await check('edit_file: 两处匹配报错带位置', async () => {
    const r = await tools[2].execute({ path: 'edit2.txt', old_text: 'DUP', new_text: 'x' }, ctx)
    if (r.success || !r.error!.includes('匹配到 2 处') || !r.error!.includes('0 个字符')) {
      throw new Error(`错误信息不符: ${r.error}`)
    }
  })

  // ---------- run_command ----------
  await check('run_command: 无 confirm 时自主执行（P3）', async () => {
    const localCtx: ToolContext = { ...ctx }
    const r = await tools[3].execute({ command: 'echo should_run' }, localCtx)
    if (!r.success || !r.output.includes('should_run')) throw new Error(`应自主执行: ${JSON.stringify(r)}`)
  })
  await check('run_command: 成功返回输出', async () => {
    const r = await tools[3].execute({ command: 'echo hello_mewcode' }, ctx)
    if (!r.success || !r.output.includes('hello_mewcode')) throw new Error(`输出不符: ${JSON.stringify(r)}`)
  })
  await check('run_command: 超时 kill', async () => {
    // Windows 下用单字符串命令避免 shell:true 的 args 拼接引号问题
    const r = await tools[3].execute({ command: 'ping -n 5 127.0.0.1', timeout: 500 }, ctx)
    if (r.success || !r.error!.includes('超时')) throw new Error(`应超时: ${JSON.stringify(r)}`)
  })
  await check('run_command: 非零退出码', async () => {
    const r = await tools[3].execute({ command: 'node', args: ['-e', 'process.exit(3)'], timeout: 5000 }, ctx)
    if (r.success || !r.error!.includes('退出码 3')) throw new Error(`退出码错误: ${JSON.stringify(r)}`)
  })
  await check('run_command: 命令不存在', async () => {
    // Windows cmd 对不存在命令返回「不是内部或外部命令」+ 退出码 1，非 spawn error 事件
    const r = await tools[3].execute({ command: 'no_such_command_xyz_123' }, ctx)
    if (r.success) throw new Error('应失败')
    if (!r.error!.includes('退出码') && !r.error!.includes('启动失败')) {
      throw new Error(`错误信息不符: ${r.error}`)
    }
  })
  await check('run_command: args 也受路径围栏保护', async () => {
    const lockedCtx: ToolContext = { ...ctx, rootLock: TMP }
    const outside = `${TMP}-outside.txt`
    const r = await tools[3].execute({ command: 'echo', args: ['x', '>', outside] }, lockedCtx)
    if (r.success || !r.error?.includes('工作目录外')) throw new Error(`args 路径未拦截: ${JSON.stringify(r)}`)
  })

  // ---------- find_files ----------
  writeFileSync(join(TMP, 'nested/deep/c.ts'), 'x', 'utf8')
  await check('find_files: glob 找到文件', async () => {
    const r = await tools[4].execute({ pattern: '**/*.ts' }, ctx)
    if (!r.success || !r.output.includes('c.ts')) throw new Error(`结果不符: ${r.output}`)
  })
  await check('find_files: 排除 node_modules', async () => {
    mkdirSync(join(TMP, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(TMP, 'node_modules/pkg/d.ts'), 'x', 'utf8')
    const r = await tools[4].execute({ pattern: '**/*.ts' }, ctx)
    if (r.output.includes('node_modules')) throw new Error(`未排除: ${r.output}`)
  })

  // ---------- grep_code ----------
  writeFileSync(join(TMP, 'grepme.txt'), 'alpha\nbeta import x\nomega import y\n', 'utf8')
  await check('grep_code: 返回 文件:行号:行内容', async () => {
    const r = await tools[5].execute({ pattern: 'import' }, ctx)
    if (!r.success) throw new Error(r.error)
    const lines = r.output.split('\n')
    if (lines.length !== 2 || !lines[0].includes(':2:') || !lines[0].includes('grepme.txt')) {
      throw new Error(`格式不符: ${r.output}`)
    }
  })
  await check('grep_code: 非法正则 → 结构化错误', async () => {
    const r = await tools[5].execute({ pattern: '[' }, ctx)
    if (r.success || !r.error!.includes('非法正则')) throw new Error(`应报非法正则: ${JSON.stringify(r)}`)
  })
  await check('grep_code: 无匹配返回未找到', async () => {
    const r = await tools[5].execute({ pattern: 'zzz_nothing_zzz' }, ctx)
    if (!r.success || !r.output.includes('未找到')) throw new Error(`结果不符: ${r.output}`)
  })

  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    // Windows 上删除含 node_modules 的目录树偶发 EPERM（句柄占用）——夹具残留无碍
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('tools 测试异常:', e)
  process.exit(1)
})
