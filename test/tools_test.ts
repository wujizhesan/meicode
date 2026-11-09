// 工具层冒烟：registry + 六工具直调
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTools, ToolRegistry } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { MAX_RESULT_BYTES, guardCommand, truncateOutput } from '../src/tools/types.ts'

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

const TMP = join(import.meta.dirname, `fixtures_tools_${process.pid}_${Date.now()}`)
mkdirSync(TMP, { recursive: true })

const ctx: ToolContext = { cwd: TMP, timeoutMs: 2000 }

async function main() {
  const tools = createTools(ctx)
  const registry = new ToolRegistry()
  tools.forEach((t) => {
    registry.register(t)
  })

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

  await check('truncateOutput: UTF-8 边界完整且不超过上限', () => {
    const result = truncateOutput('中😀'.repeat(3000))
    if (!result.truncated) throw new Error('超长输出未截断')
    if (Buffer.byteLength(result.output, 'utf8') > MAX_RESULT_BYTES) throw new Error('截断结果超过字节上限')
    if (result.output.includes('\ufffd')) throw new Error('截断破坏了 UTF-8 字符边界')
    if (!result.output.endsWith('…[结果已截断]')) throw new Error('缺少截断标记')
  })

  await check('rootLock: Git 输出参数不能绕过写围栏', () => {
    const lockedCtx: ToolContext = { ...ctx, rootLock: TMP }
    for (const command of [
      'git diff --output=C:\\outside\\leak.patch',
      'git diff --output=..\\leak.patch',
      'git log --output C:\\outside\\leak.txt',
      'git diff --ext-diff',
    ]) {
      if (!guardCommand(lockedCtx, command)) throw new Error(`写围栏未拦截: ${command}`)
    }
  })
  await check('run_command: args 形式的 Git 输出参数受写围栏保护', async () => {
    const lockedCtx: ToolContext = { ...ctx, rootLock: TMP }
    const result = await tools[3].execute({ command: 'git', args: ['diff', '--output=C:\\outside\\leak.patch'] }, lockedCtx)
    if (result.success || !result.error?.includes('Git 输出')) throw new Error(`args 输出参数未拦截: ${JSON.stringify(result)}`)
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
  await check('write_file: 覆盖已有文件', async () => {
    const file = join(TMP, 'write-overwrite.txt')
    writeFileSync(file, 'old content')
    const r = await tools[1].execute({ path: file, content: 'new' }, ctx)
    if (!r.success || readFileSync(file, 'utf8') !== 'new') throw new Error(`覆盖异常: ${JSON.stringify(r)}`)
  })
  await check('write_file: 已取消时不创建或覆盖文件', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelledCtx: ToolContext = { ...ctx, signal: controller.signal }
    const newFile = join(TMP, 'cancel-write', 'nested', 'new.txt')
    const created = await tools[1].execute({ path: newFile, content: 'new' }, cancelledCtx)
    if (created.success || !created.error?.includes('取消') || existsSync(join(TMP, 'cancel-write'))) {
      throw new Error(`已取消时创建了目录或文件: ${JSON.stringify(created)}`)
    }
    const existing = join(TMP, 'cancel-existing.txt')
    writeFileSync(existing, 'old')
    const overwritten = await tools[1].execute({ path: existing, content: 'new' }, cancelledCtx)
    if (overwritten.success || !overwritten.error?.includes('取消') || readFileSync(existing, 'utf8') !== 'old') {
      throw new Error(`已取消时覆盖了文件: ${JSON.stringify(overwritten)}`)
    }
  })
  await check('write_file: 创建目录期间取消时不写文件', async () => {
    const controller = new AbortController()
    const file = join(TMP, 'cancel-during-mkdir', 'new.txt')
    const pending = tools[1].execute({ path: file, content: 'new' }, { ...ctx, signal: controller.signal })
    controller.abort()
    const result = await pending
    if (result.success || !result.error?.includes('取消') || existsSync(file)) {
      throw new Error(`创建目录期间取消后仍写入: ${JSON.stringify(result)}`)
    }
  })
  await check('write_file: 同进程目录链接切换不能越界写入', async () => {
    const allowed = join(TMP, 'write-guard-allowed')
    const outside = join(TMP, 'write-guard-outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    const lockedCtx: ToolContext = { ...ctx, cwd: allowed, rootLock: allowed }
    for (let index = 0; index < 20; index++) {
      const link = join(allowed, `jump-${index}`)
      const outsideFile = join(outside, `probe-${index}.txt`)
      const pending = tools[1].execute({ path: join(link, `probe-${index}.txt`), content: 'OUTSIDE_WRITE' }, lockedCtx)
      let linked = false
      try {
        symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
        linked = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const result = await pending
      if (existsSync(outsideFile) || (linked && result.success)) {
        throw new Error(`目录链接越界写入: ${JSON.stringify(result)}`)
      }
    }
  })

  // ---------- read_file ----------
  await check('read_file: 读回一致', async () => {
    const r = await tools[0].execute({ path: 'a.txt' }, ctx)
    if (!r.success || r.output !== 'hello 世界') throw new Error(`内容不符: ${r.output}`)
  })
  await check('read_file: 已取消时不读取文件或返回内容', async () => {
    const controller = new AbortController()
    controller.abort()
    for (const path of ['a.txt', 'missing.txt']) {
      const result = await tools[0].execute({ path }, { ...ctx, signal: controller.signal })
      if (result.success || !result.error?.includes('取消') || result.output !== '' || result.evidence) {
        throw new Error(`已取消请求仍读取文件: ${JSON.stringify(result)}`)
      }
    }
  })
  await check('read_file: 打开文件期间取消时丢弃内容', async () => {
    const controller = new AbortController()
    const pending = tools[0].execute({ path: 'a.txt' }, { ...ctx, signal: controller.signal })
    controller.abort()
    const result = await pending
    if (result.success || !result.error?.includes('取消') || result.output !== '' || result.evidence) {
      throw new Error(`打开文件期间取消后仍返回内容: ${JSON.stringify(result)}`)
    }
    const reread = await tools[0].execute({ path: 'a.txt' }, ctx)
    if (!reread.success || reread.output !== 'hello 世界') throw new Error(`取消后读取异常: ${JSON.stringify(reread)}`)
  })
  await check('read_file: 不存在文件 → 结构化错误', async () => {
    const r = await tools[0].execute({ path: 'missing.txt' }, ctx)
    if (r.success || !r.error?.includes('读取失败')) throw new Error(`应失败: ${JSON.stringify(r)}`)
  })
  await check('read_file: 绝对路径', async () => {
    const r = await tools[0].execute({ path: join(TMP, 'a.txt') }, ctx)
    if (!r.success || r.output !== 'hello 世界') throw new Error('绝对路径失败')
  })
  await check('read_file: 大文件仅返回受限前缀', async () => {
    writeFileSync(join(TMP, 'read-large.txt'), 'x'.repeat(1024 * 1024), 'utf8')
    const r = await tools[0].execute({ path: 'read-large.txt' }, ctx)
    if (!r.success || !r.truncated || !/…\[结果已截断；下一页 offset=\d+\]$/.test(r.output)) throw new Error(`大文件截断异常: ${JSON.stringify(r)}`)
    if (Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) throw new Error('大文件结果超过字节上限')
  })
  await check('read_file: UTF-8 截断边界完整', async () => {
    writeFileSync(join(TMP, 'read-utf8.txt'), '中😀'.repeat(3000), 'utf8')
    const r = await tools[0].execute({ path: 'read-utf8.txt' }, ctx)
    if (!r.success || !r.truncated || r.output.includes('�')) throw new Error(`UTF-8 截断异常: ${JSON.stringify(r)}`)
    if (Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) throw new Error('UTF-8 结果超过字节上限')
  })
  await check('read_file: 分页可无遗漏地拼回文本', async () => {
    const content = '中😀'.repeat(3000) + 'TAIL_MARKER'
    writeFileSync(join(TMP, 'read-pages.txt'), content, 'utf8')
    let offset = 0
    let collected = ''
    for (let page = 0; page < 5; page++) {
      const r = await tools[0].execute({ path: 'read-pages.txt', offset }, ctx)
      if (!r.success || r.output.includes('�') || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error(`分页结果异常: ${JSON.stringify(r).slice(0, 300)}`)
      }
      if (!r.truncated) {
        collected += r.output
        break
      }
      const match = r.output.match(/\n…\[结果已截断；下一页 offset=(\d+)\]$/)
      if (!match) throw new Error('截断结果缺少下一页偏移量')
      const body = r.output.slice(0, -match[0].length)
      const nextOffset = Number(match[1])
      if (nextOffset !== offset + Buffer.byteLength(body, 'utf8')) throw new Error('偏移量与本页内容字节数不符')
      collected += body
      offset = nextOffset
    }
    if (collected !== content) throw new Error('分页拼接与原文件不一致')
  })
  await check('read_file: 拒绝无效或位于字符中间的 offset', async () => {
    for (const offset of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER]) {
      const r = await tools[0].execute({ path: 'read-pages.txt', offset }, ctx)
      if (r.success || !r.error?.includes('offset')) throw new Error(`无效 offset 未被拒绝: ${JSON.stringify(r)}`)
    }
    const r = await tools[0].execute({ path: 'read-pages.txt', offset: 1 }, ctx)
    if (r.success || !r.error?.includes('字符中间')) throw new Error(`字符中间 offset 未被拒绝: ${JSON.stringify(r)}`)
  })
  await check('read_file: 文件末尾偏移量返回空内容', async () => {
    const r = await tools[0].execute({ path: 'read-pages.txt', offset: Buffer.byteLength('中😀'.repeat(3000) + 'TAIL_MARKER', 'utf8') }, ctx)
    if (!r.success || r.truncated || r.output !== '') throw new Error(`文件末尾读取异常: ${JSON.stringify(r)}`)
  })

  // ---------- edit_file ----------
  writeFileSync(join(TMP, 'edit.txt'), 'line1\nTARGET line2\nline3\n', 'utf8')
  await check('edit_file: 唯一匹配替换', async () => {
    const r = await tools[2].execute({ path: 'edit.txt', old_text: 'TARGET', new_text: 'CHANGED' }, ctx)
    if (!r.success) throw new Error(r.error)
    const content = readFileSync(join(TMP, 'edit.txt'), 'utf8')
    if (!content.includes('CHANGED') || content.includes('TARGET')) throw new Error('替换结果不符')
  })
  await check('edit_file: 已取消时不修改文件', async () => {
    const file = join(TMP, 'cancel-edit.txt')
    writeFileSync(file, 'BEFORE')
    const controller = new AbortController()
    controller.abort()
    const result = await tools[2].execute(
      { path: file, old_text: 'BEFORE', new_text: 'AFTER' },
      { ...ctx, signal: controller.signal },
    )
    if (result.success || !result.error?.includes('取消') || readFileSync(file, 'utf8') !== 'BEFORE') {
      throw new Error(`已取消时修改了文件: ${JSON.stringify(result)}`)
    }
  })
  await check('edit_file: 零匹配报错', async () => {
    const r = await tools[2].execute({ path: 'edit.txt', old_text: 'NO_SUCH_TEXT', new_text: 'x' }, ctx)
    if (r.success || !r.error!.includes('未找到')) throw new Error(`应报未找到: ${JSON.stringify(r)}`)
  })
  writeFileSync(join(TMP, 'edit2.txt'), 'DUP\nDUP\nend\n', 'utf8')
  await check('edit_file: 两处匹配报错带位置', async () => {
    const r = await tools[2].execute({ path: 'edit2.txt', old_text: 'DUP', new_text: 'x' }, ctx)
    if (r.success || !r.error!.includes('匹配到多处') || !r.error!.includes('0 个字符')) {
      throw new Error(`错误信息不符: ${r.error}`)
    }
  })
  await check('edit_file: 重叠匹配拒绝替换且保留原文件', async () => {
    const file = join(TMP, 'edit-overlap.txt')
    writeFileSync(file, 'aaaa', 'utf8')
    const r = await tools[2].execute({ path: 'edit-overlap.txt', old_text: 'aaa', new_text: 'X' }, ctx)
    if (r.success || !r.error?.includes('匹配到多处') || readFileSync(file, 'utf8') !== 'aaaa') {
      throw new Error(`重叠匹配处理异常: ${JSON.stringify(r)}`)
    }
  })
  await check('edit_file: 并发编辑同一文件保留两次修改', async () => {
    const file = join(TMP, 'edit-concurrent.txt')
    writeFileSync(file, `A${'x'.repeat(1_000_000)}B`, 'utf8')
    const results = await Promise.all([
      tools[2].execute({ path: 'edit-concurrent.txt', old_text: 'A', new_text: '1' }, ctx),
      tools[2].execute({ path: 'edit-concurrent.txt', old_text: 'B', new_text: '2' }, ctx),
    ])
    const content = readFileSync(file, 'utf8')
    if (results.some((r) => !r.success) || !content.startsWith('1') || !content.endsWith('2')) {
      throw new Error(`并发编辑丢失修改: ${JSON.stringify(results)}`)
    }
  })
  await check('edit_file: new_text 按字面量替换', async () => {
    writeFileSync(join(TMP, 'edit-literal.txt'), 'before TARGET after', 'utf8')
    const r = await tools[2].execute({ path: 'edit-literal.txt', old_text: 'TARGET', new_text: '$& literal' }, ctx)
    if (!r.success || readFileSync(join(TMP, 'edit-literal.txt'), 'utf8') !== 'before $& literal after') {
      throw new Error(`edit_file 字面量替换异常: ${JSON.stringify(r)}`)
    }
  })
  await check('edit_file: 长文本替换正确写入且返回结果受限', async () => {
    const replacement = '中😀'.repeat(3000)
    writeFileSync(join(TMP, 'edit-large.txt'), 'TARGET', 'utf8')
    const r = await tools[2].execute({ path: 'edit-large.txt', old_text: 'TARGET', new_text: replacement }, ctx)
    if (!r.success || !r.truncated || !r.output.endsWith('…[结果已截断]') || r.output.includes('�')
      || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES
      || readFileSync(join(TMP, 'edit-large.txt'), 'utf8') !== replacement) {
      throw new Error(`edit_file 长文本截断异常: ${JSON.stringify(r).slice(0, 300)}`)
    }
  })
  await check('edit_file: 拒绝空 old_text', async () => {
    const r = await tools[2].execute({ path: 'edit.txt', old_text: '', new_text: 'x' }, ctx)
    if (r.success || !r.error?.includes('缺少参数')) throw new Error(`edit_file 未拒绝空 old_text: ${JSON.stringify(r)}`)
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
  await check('run_command: 大输出保留尾部并标记截断', async () => {
    const script = 'process.stdout.write("HEAD_MARKER" + "x".repeat(100000) + "TAIL_MARKER")'
    const r = await tools[3].execute({ command: process.execPath, args: ['-e', script] }, ctx)
    if (!r.success || !r.truncated || !r.output.includes('TAIL_MARKER') || r.output.includes('HEAD_MARKER')
      || !r.output.endsWith('…[结果已截断]') || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) {
      throw new Error(`输出尾部截断异常: ${JSON.stringify(r).slice(0, 300)}`)
    }
  })
  await check('run_command: UTF-8 字符跨块解码', async () => {
    const script = 'process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8, 0xad])), 40)'
    const r = await tools[3].execute({ command: process.execPath, args: ['-e', script] }, ctx)
    if (!r.success || r.truncated || r.output !== '中') throw new Error(`跨块 UTF-8 解码异常: ${JSON.stringify(r)}`)
  })
  await check('run_command: UTF-8 尾部截断保持字符完整', async () => {
    const script = 'process.stdout.write("中😀".repeat(10000))'
    const r = await tools[3].execute({ command: process.execPath, args: ['-e', script] }, ctx)
    if (!r.success || !r.truncated || r.output.includes('�') || !r.output.endsWith('…[结果已截断]')
      || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) {
      throw new Error(`UTF-8 尾部截断异常: ${JSON.stringify(r).slice(0, 300)}`)
    }
  })
  await check('run_command: 超时 kill', async () => {
    // 用 node 自身睡眠，而不是 ping：新版 ubuntu-latest 运行器已禁止 ICMP 原始套接字，
    // ping 会立刻以退出码 2 结束（"record route: Operation not permitted"），测不出超时。
    const r = await tools[3].execute({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeout: 500,
    }, ctx)
    if (r.success || !r.error!.includes('超时')) throw new Error(`应超时: ${JSON.stringify(r)}`)
  })
  await check('run_command: 无效超时在命令启动前拒绝', async () => {
    for (const timeout of [0, -1, 0.5, 2_147_483_648, NaN, Infinity, '1000', null]) {
      const r = await tools[3].execute({ command: 'missing-timeout-probe-command', args: ['x'], timeout }, ctx)
      if (r.success || !r.error?.includes('参数 timeout 必须') || r.output !== '') {
        throw new Error(`无效超时未拒绝 (${String(timeout)}): ${JSON.stringify(r)}`)
      }
    }
    const invalidContext = await tools[3].execute({ command: 'missing-timeout-probe-command', args: ['x'] }, { ...ctx, timeoutMs: 0 })
    if (invalidContext.success || !invalidContext.error?.includes('参数 timeout 必须')) {
      throw new Error(`无效上下文超时未拒绝: ${JSON.stringify(invalidContext)}`)
    }
    const valid = await tools[3].execute({ command: process.execPath, args: ['-e', 'process.stdout.write("READY")'], timeout: 2_147_483_647 }, { ...ctx, timeoutMs: 0 })
    if (!valid.success || valid.output !== 'READY') throw new Error(`最大合法超时未接受: ${JSON.stringify(valid)}`)
  })
  await check('run_command: taskkill 启动失败时超时和取消不崩溃', async () => {
    if (process.platform !== 'win32') return
    const moduleUrl = new URL('../src/tools/run_command.ts', import.meta.url).href
    const worker = `
      import { runCommandTool } from ${JSON.stringify(moduleUrl)}
      const cwd = process.cwd()
      const originalRoot = process.env.SystemRoot
      process.env.PATH = ''
      const command = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 2000)'] }
      const timeoutPending = runCommandTool.execute({ ...command, timeout: 100 }, { cwd })
      process.env.SystemRoot = 'Z:/meicode-missing-system-root'
      const timedOut = await timeoutPending
      if (timedOut.success || !timedOut.error?.includes('超时')) throw new Error(JSON.stringify(timedOut))
      process.env.SystemRoot = originalRoot
      const controller = new AbortController()
      const cancelPending = runCommandTool.execute({ ...command, timeout: 5000 }, { cwd, signal: controller.signal })
      process.env.SystemRoot = 'Z:/meicode-missing-system-root'
      setTimeout(() => controller.abort(), 100)
      const cancelled = await cancelPending
      if (cancelled.success || !cancelled.error?.includes('取消')) throw new Error(JSON.stringify(cancelled))
    `
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker], {
        cwd: join(import.meta.dirname, '..'),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', (code) => code === 0 ? resolve(code) : reject(new Error(`隔离进程退出码 ${code}: ${stderr}`)))
    })
    if (exitCode !== 0) throw new Error(`隔离进程退出码 ${exitCode}`)
  })
  await check('run_command: 非零退出码', async () => {
    const r = await tools[3].execute({ command: 'node', args: ['-e', 'process.exit(3)'], timeout: 5000 }, ctx)
    if (r.success || !r.error!.includes('退出码 3')) throw new Error(`退出码错误: ${JSON.stringify(r)}`)
  })
  await check('run_command: args 保持参数边界且不经过 shell', async () => {
    const marker = 'structured & literal'
    const r = await tools[3].execute({ command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', marker] }, ctx)
    if (!r.success || r.output !== marker) throw new Error(`参数边界丢失: ${JSON.stringify(r)}`)
  })
  await check('run_command: Windows npm 带 args 可执行', async () => {
    if (process.platform !== 'win32') return
    // 不给显式预算：Windows CI 上冷启动 npm 实测可超过默认 2s 预算。
    // 这里要验证的是「带 args 的 npm 能被正确spawn 起来」，不是它跑得多快
    const r = await tools[3].execute({ command: 'npm', args: ['--version'], timeout: 15000 }, ctx)
    if (!r.success || !/^\d+\.\d+\.\d+$/.test(r.output.trim())) throw new Error(`npm 带参启动失败: ${JSON.stringify(r)}`)
  })
  await check('run_command: Windows 批处理参数保持边界并拒绝危险字符', async () => {
    if (process.platform !== 'win32') return
    const script = join(TMP, 'probe & args.cmd')
    const js = join(TMP, 'probe-args.js')
    writeFileSync(js, 'console.log(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(script, `@echo off\r\n"${process.execPath}" "%~dp0\\probe-args.js" %*\r\n`)
    const args = ['hello world', 'a&b', 'x|y', 'x>y', 'C:\\path\\', 'next', '']
    const r = await tools[3].execute({ command: script, args }, ctx)
    if (!r.success || r.output.trim() !== JSON.stringify(args)) throw new Error(`批处理参数丢失: ${JSON.stringify(r)}`)
    for (const value of ['x" & echo HACKED', '%PATH%', 'x^y', 'x!y', 'x\ny']) {
      const blocked = await tools[3].execute({ command: script, args: [value] }, ctx)
      if (blocked.success || !blocked.error?.includes('无法安全传递')) throw new Error(`危险参数未拒绝: ${JSON.stringify(blocked)}`)
    }
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

  // 围栏必须覆盖 POSIX 绝对路径：原实现只认盘符路径，Linux/macOS 上等于没围栏。
  // 同时确保不误杀 URL、相对路径与含斜杠的普通参数。
  await check('run_command: 围栏覆盖 POSIX 绝对路径且不误杀 URL/相对路径', () => {
    const locked: ToolContext = { ...ctx, rootLock: TMP }
    for (const command of ['echo x > /etc/passwd', 'find / -name secret', 'echo x > C:/Windows/outside.txt']) {
      if (!guardCommand(locked, command)?.includes('工作目录外')) throw new Error(`未拦截: ${command}`)
    }
    for (const command of [
      'curl https://api.example.com/v1/data',
      'echo a/b/c',
      "sed 's/a/b/' file.txt",
      'date +%m/%d',
      `echo x > ${join(TMP, 'inside.txt')}`,
    ]) {
      const reason = guardCommand(locked, command)
      if (reason) throw new Error(`误杀: ${command} => ${reason}`)
    }
  })

  // ---------- find_files ----------
  writeFileSync(join(TMP, 'nested/deep/c.ts'), 'x', 'utf8')
  await check('find_files: glob 找到文件', async () => {
    const r = await tools[4].execute({ pattern: '**/*.ts' }, ctx)
    if (!r.success || !r.output.includes('c.ts')) throw new Error(`结果不符: ${r.output}`)
  })
  await check('find_files: 请求前和遍历中取消均停止查找', async () => {
    const root = join(TMP, 'find-cancel')
    mkdirSync(root)
    writeFileSync(join(root, 'sample.ts'), '')
    const cancelled = new AbortController()
    cancelled.abort()
    const before = await tools[4].execute({ pattern: '**/*.ts', path: root }, { ...ctx, signal: cancelled.signal })
    if (before.success || !before.error?.includes('取消') || before.output !== '') {
      throw new Error(`预先取消未生效: ${JSON.stringify(before)}`)
    }
    const controller = new AbortController()
    const pending = tools[4].execute({ pattern: '**/*.ts', path: root }, { ...ctx, signal: controller.signal })
    controller.abort()
    const during = await pending
    if (during.success || !during.error?.includes('取消') || during.output !== '') {
      throw new Error(`遍历中取消未生效: ${JSON.stringify(during)}`)
    }
  })
  await check('find_files: 排除 node_modules', async () => {
    mkdirSync(join(TMP, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(TMP, 'node_modules/pkg/d.ts'), 'x', 'utf8')
    const r = await tools[4].execute({ pattern: '**/*.ts' }, ctx)
    if (r.output.includes('node_modules')) throw new Error(`未排除: ${r.output}`)
  })
  await check('find_files: 缓存后发现新增和删除的目录及文件', async () => {
    const root = join(TMP, `find-cache-${process.pid}-${Date.now()}`)
    const child = join(root, 'child')
    const file = join(child, 'fresh.cacheprobe')
    mkdirSync(root, { recursive: true })
    const search = () => tools[4].execute({ pattern: '**/*.cacheprobe', path: root }, ctx)
    const first = await search()
    if (!first.success || !first.output.includes('未找到')) throw new Error(`初次搜索异常: ${JSON.stringify(first)}`)
    mkdirSync(child)
    writeFileSync(file, 'x')
    const added = await search()
    if (!added.success || !added.output.includes('child/fresh.cacheprobe')) throw new Error(`未发现新增文件: ${JSON.stringify(added)}`)
    rmSync(file)
    const removed = await search()
    if (!removed.success || !removed.output.includes('未找到')) throw new Error(`未发现删除文件: ${JSON.stringify(removed)}`)
    writeFileSync(file, 'y')
    const restored = await search()
    if (!restored.success || !restored.output.includes('child/fresh.cacheprobe')) throw new Error(`未发现重新创建的文件: ${JSON.stringify(restored)}`)
    rmSync(file)
    rmdirSync(child)
    const removedDir = await search()
    if (!removedDir.success || !removedDir.output.includes('未找到')) throw new Error(`未发现删除目录: ${JSON.stringify(removedDir)}`)
  })
  await check('find_files: 固定目录前缀保持 glob 语义', async () => {
    const root = join(TMP, `find-prefix-${process.pid}-${Date.now()}`)
    for (const dir of ['src/tools', 'src/toolsmith', 'test', 'other']) mkdirSync(join(root, dir), { recursive: true })
    for (const file of ['src/tools/a.ts', 'src/toolsmith/b.ts', 'test/c.ts', 'other/d.ts']) writeFileSync(join(root, file), 'x')
    const search = (pattern: string) => tools[4].execute({ pattern, path: root }, ctx)
    const exact = await search('src/tools/*.ts')
    if (!exact.success || exact.output !== 'src/tools/a.ts') throw new Error(`固定前缀结果异常: ${JSON.stringify(exact)}`)
    const brace = await search('src/{tools,toolsmith}/*.ts')
    if (!brace.success || brace.output !== 'src/tools/a.ts\nsrc/toolsmith/b.ts') throw new Error(`分支前缀结果异常: ${JSON.stringify(brace)}`)
    const normalized = await search('src/../test/*.ts')
    if (!normalized.success || normalized.output !== 'test/c.ts') throw new Error(`规范化前缀结果异常: ${JSON.stringify(normalized)}`)
    const missing = await search('src/new/*.ts')
    if (!missing.success || missing.output !== '未找到匹配文件') throw new Error(`缺失目录结果异常: ${JSON.stringify(missing)}`)
    mkdirSync(join(root, 'src/new'))
    writeFileSync(join(root, 'src/new/e.ts'), 'x')
    const added = await search('src/new/*.ts')
    if (!added.success || added.output !== 'src/new/e.ts') throw new Error(`新增前缀结果异常: ${JSON.stringify(added)}`)
    const negated = await search('!src/tools/*.ts')
    if (!negated.success || negated.output.includes('src/tools/a.ts') || negated.output.split('\n').length !== 4) {
      throw new Error(`取反模式结果异常: ${JSON.stringify(negated)}`)
    }
  })
  await check('find_files: 无 globstar 时限制搜索层级', async () => {
    const root = join(TMP, `find-depth-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, 'src/deep'), { recursive: true })
    for (const file of ['root.ts', 'src/direct.ts', 'src/deep/nested.ts']) writeFileSync(join(root, file), 'x')
    const search = (pattern: string) => tools[4].execute({ pattern, path: root }, ctx)
    const rootFiles = await search('*.ts')
    if (!rootFiles.success || rootFiles.output !== 'root.ts') throw new Error(`根目录层级结果异常: ${JSON.stringify(rootFiles)}`)
    const direct = await search('src/*.ts')
    if (!direct.success || direct.output !== 'src/direct.ts') throw new Error(`固定层级结果异常: ${JSON.stringify(direct)}`)
    const recursive = await search('src/**/*.ts')
    if (!recursive.success || recursive.output !== 'src/deep/nested.ts\nsrc/direct.ts') {
      throw new Error(`递归模式结果异常: ${JSON.stringify(recursive)}`)
    }
    const alternatives = await search('{root.ts,src/deep/nested.ts}')
    if (!alternatives.success || alternatives.output !== 'root.ts\nsrc/deep/nested.ts') {
      throw new Error(`不同层级分支结果异常: ${JSON.stringify(alternatives)}`)
    }
  })
  await check('find_files: 恰好 100 条完整返回，超过 100 条才截断', async () => {
    const root = join(TMP, 'find-count-limit')
    mkdirSync(root)
    for (let index = 0; index < 101; index++) {
      writeFileSync(join(root, `${String(index).padStart(3, '0')}.probe`), '')
      const count = index + 1
      if (count !== 99 && count !== 100 && count !== 101) continue
      const r = await tools[4].execute({ pattern: '*.probe', path: root }, ctx)
      const lines = r.output.split('\n')
      const marker = count > 100 ? lines.pop() : undefined
      const expected = Array.from({ length: Math.min(count, 100) }, (_, i) => `${String(i).padStart(3, '0')}.probe`)
      if (!r.success || r.truncated !== (count > 100) || marker !== (count > 100 ? '…[仅显示前 100 条]' : undefined)
        || lines.join('\n') !== expected.join('\n')) {
        throw new Error(`数量边界异常 (${count}): ${JSON.stringify(r).slice(0, 300)}`)
      }
    }
  })
  await check('find_files: 截断时返回全局排序前 100 条', async () => {
    const root = join(TMP, 'find-global-first')
    mkdirSync(join(root, 'a'), { recursive: true })
    for (let index = 0; index < 101; index++) {
      writeFileSync(join(root, 'a', `${String(index).padStart(3, '0')}.ts`), '')
    }
    writeFileSync(join(root, 'a.ts'), '')
    const expected = ['a.ts', ...Array.from({ length: 101 }, (_, index) => `a/${String(index).padStart(3, '0')}.ts`)].sort().slice(0, 100)
    const r = await tools[4].execute({ pattern: '**/*.ts', path: root }, ctx)
    if (!r.success || !r.truncated || r.output !== `${expected.join('\n')}\n…[仅显示前 100 条]`) {
      throw new Error(`全局排序截断异常: ${JSON.stringify(r).slice(0, 300)}`)
    }
  })
  await check('find_files: 长路径结果遵守 UTF-8 字节上限并保留完整路径', async () => {
    const root = join(TMP, `find-byte-limit-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    for (let index = 0; index < 90; index++) {
      writeFileSync(join(root, `${'中'.repeat(50)}-${String(index).padStart(2, '0')}.ts`), '')
    }
    const r = await tools[4].execute({ pattern: '*.ts', path: root }, ctx)
    const lines = r.output.split('\n')
    const marker = lines.pop()
    if (!r.success || !r.truncated || lines.length === 0 || lines.length >= 90
      || marker !== `…[仅显示前 ${lines.length} 条]`
      || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES || r.output.includes('�')
      || lines.some((line) => !/^中{50}-\d{2}\.ts$/.test(line))
      || lines.join('\n') !== [...lines].sort().join('\n')) {
      throw new Error(`find_files 字节上限异常: ${JSON.stringify(r).slice(0, 300)}`)
    }
  })

  // ---------- grep_code ----------
  writeFileSync(join(TMP, 'grepme.txt'), 'alpha\nbeta import x\nomega import y import z\n', 'utf8')
  await check('grep_code: 返回 文件:行号:行内容', async () => {
    const r = await tools[5].execute({ pattern: 'import' }, ctx)
    if (!r.success) throw new Error(r.error)
    const lines = r.output.split('\n')
    if (lines.length !== 2 || !lines[0].includes(':2:') || !lines[0].includes('grepme.txt')) {
      throw new Error(`格式不符: ${r.output}`)
    }
  })
  await check('grep_code: 正则模式保持逐行语义', async () => {
    const r = await tools[5].execute({ pattern: '^omega' }, ctx)
    if (!r.success || !r.output.includes(':3:') || !r.output.includes('omega import y')) throw new Error(`结果不符: ${r.output}`)
  })
  await check('grep_code: 字面量和正则搜索响应取消', async () => {
    const root = join(TMP, 'grep-cancel')
    mkdirSync(root)
    writeFileSync(join(root, 'sample.txt'), 'NEEDLE\n')
    const cancelled = new AbortController()
    cancelled.abort()
    for (const pattern of ['NEEDLE', '^NEEDLE']) {
      const r = await tools[5].execute({ pattern, path: root }, { ...ctx, signal: cancelled.signal })
      if (r.success || !r.error?.includes('取消') || r.output !== '') {
        throw new Error(`预先取消未生效 (${pattern}): ${JSON.stringify(r)}`)
      }
    }
    const controller = new AbortController()
    const pending = tools[5].execute({ pattern: 'NEEDLE', path: root }, { ...ctx, signal: controller.signal })
    controller.abort()
    const interrupted = await pending
    if (interrupted.success || !interrupted.error?.includes('取消') || interrupted.output !== '') {
      throw new Error(`搜索中取消未生效: ${JSON.stringify(interrupted)}`)
    }
  })
  await check('grep_code: 病态正则按超时或取消返回且不阻塞主线程', async () => {
    const root = join(TMP, 'grep-regex-timeout')
    mkdirSync(root)
    writeFileSync(join(root, 'line.txt'), `${'a'.repeat(28)}!`)
    const moduleUrl = new URL('../src/tools/grep_code.ts', import.meta.url).href
    const worker = `
      import { grepCodeTool } from ${JSON.stringify(moduleUrl)}
      const root = ${JSON.stringify(root)}
      let ticked = false
      setTimeout(() => { ticked = true }, 20)
      const started = Date.now()
      const timedOut = await grepCodeTool.execute({ pattern: '(a+)+$', path: root }, { cwd: root, timeoutMs: 300 })
      if (timedOut.success || !timedOut.error?.includes('超时') || !ticked || Date.now() - started > 1500) {
        throw new Error('正则超时未生效: ' + JSON.stringify(timedOut))
      }
      const controller = new AbortController()
      const pending = grepCodeTool.execute({ pattern: '(a+)+$', path: root }, { cwd: root, timeoutMs: 5000, signal: controller.signal })
      setTimeout(() => controller.abort(), 50)
      const cancelled = await pending
      if (cancelled.success || !cancelled.error?.includes('取消')) throw new Error('正则取消未生效: ' + JSON.stringify(cancelled))
    `
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker], {
        cwd: join(import.meta.dirname, '..'),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      let timedOut = false
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      const watchdog = setTimeout(() => { timedOut = true; child.kill() }, 2500)
      child.once('error', reject)
      child.once('close', (code) => {
        clearTimeout(watchdog)
        if (timedOut) reject(new Error('隔离正则测试超过 2500ms'))
        else if (code !== 0) reject(new Error(`隔离正则测试退出码 ${code}: ${stderr}`))
        else resolve()
      })
    })
  })
  await check('grep_code: 非法正则 → 结构化错误', async () => {
    const r = await tools[5].execute({ pattern: '[' }, ctx)
    if (r.success || !r.error!.includes('非法正则')) throw new Error(`应报非法正则: ${JSON.stringify(r)}`)
  })
  await check('grep_code: 无匹配返回未找到', async () => {
    const r = await tools[5].execute({ pattern: 'zzz_nothing_zzz' }, ctx)
    if (!r.success || !r.output.includes('未找到')) throw new Error(`结果不符: ${r.output}`)
  })
  await check('grep_code: 无效搜索目录返回错误', async () => {
    for (const path of ['grep-missing-root', 'grepme.txt']) {
      const r = await tools[5].execute({ pattern: 'needle', path }, ctx)
      if (r.success || !r.error?.startsWith('搜索失败:')) throw new Error(`目录错误被误报为无匹配: ${JSON.stringify(r)}`)
    }
  })
  await check('grep_code: 多文件匹配遵守 UTF-8 字节上限并保留完整行', async () => {
    const root = join(TMP, 'grep-byte-limit')
    mkdirSync(root, { recursive: true })
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(root, `sample-${index}.txt`), ('BYTE_LIMIT_MATCH' + '中'.repeat(100) + '\n').repeat(20))
    }
    const r = await tools[5].execute({ pattern: 'BYTE_LIMIT_MATCH', path: root }, ctx)
    const matches = r.output.split('\n').slice(0, -1)
    if (!r.success || !r.truncated || !r.output.endsWith('…[结果过多已截断]')
      || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES || r.output.includes('�')
      || matches.length >= 100 || matches.some((line) => !/^sample-\d+\.txt:\d+: BYTE_LIMIT_MATCH中{100}$/.test(line))) {
      throw new Error(`grep_code 字节上限异常: ${JSON.stringify(r).slice(0, 300)}`)
    }
  })
  await check('grep_code: 仅在完整结果超过字节上限时截断', async () => {
    const root = join(TMP, 'grep-byte-boundary')
    mkdirSync(root)
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `${index}.txt`,
      lines: Array.from({ length: 20 }, () => `EDGE${'x'.repeat(60)}`),
    }))
    const expected = () => files.flatMap((file) => file.lines.slice(0, 20).map((line, index) => `${file.name}:${index + 1}: ${line}`))
    const writeFixture = () => { for (const file of files) writeFileSync(join(root, file.name), file.lines.join('\n')) }
    let extra = MAX_RESULT_BYTES - 1 - Buffer.byteLength(expected().join('\n'), 'utf8')
    if (extra < 0) throw new Error('测试数据已超出字节上限')
    for (const file of files) {
      for (let index = 0; index < file.lines.length && extra > 0; index++) {
        const add = Math.min(200 - file.lines[index].length, extra)
        file.lines[index] += 'x'.repeat(add)
        extra -= add
      }
    }
    if (extra !== 0) throw new Error('无法构造字节边界测试数据')
    const search = (pattern: string) => tools[5].execute({ pattern, path: root }, ctx)
    for (const target of [MAX_RESULT_BYTES - 1, MAX_RESULT_BYTES]) {
      if (target === MAX_RESULT_BYTES) files[4].lines[19] += 'x'
      writeFixture()
      const full = expected().sort().join('\n')
      if (Buffer.byteLength(full, 'utf8') !== target) throw new Error('完整结果字节数错误')
      for (const pattern of ['EDGE', '^EDGE']) {
        const r = await search(pattern)
        if (!r.success || r.truncated || r.output.split('\n').sort().join('\n') !== full) {
          throw new Error(`完整结果被误截断 (${pattern}, ${target}): ${JSON.stringify(r).slice(0, 300)}`)
        }
      }
    }
    files[4].lines[19] += 'x'
    writeFixture()
    for (const pattern of ['EDGE', '^EDGE']) {
      const r = await search(pattern)
      if (!r.success || !r.truncated || !r.output.endsWith('…[结果过多已截断]')
        || r.output.split('\n').length !== 100 || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error(`超出字节上限未正确截断 (${pattern}): ${JSON.stringify(r).slice(0, 300)}`)
      }
    }
    files[4].lines[19] = files[4].lines[19].slice(0, -1)
    files[0].lines.push('EDGE')
    writeFixture()
    for (const pattern of ['EDGE', '^EDGE']) {
      const r = await search(pattern)
      if (!r.success || !r.truncated || !r.output.endsWith('…[结果过多已截断]')
        || r.output.split('\n').length !== 100 || Buffer.byteLength(r.output, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error(`隐藏命中未保留截断提示 (${pattern}): ${JSON.stringify(r).slice(0, 300)}`)
      }
    }
  })
  await check('grep_code: 字面量和正则摘要不拆分 emoji', async () => {
    const root = join(TMP, 'grep-surrogate-preview')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'emoji.txt'), `${'x'.repeat(199)}😀EMOJI_MATCH\n`)
    const expected = `emoji.txt:1: ${'x'.repeat(199)}😀`
    for (const pattern of ['EMOJI_MATCH', 'EMOJI_MATCH$']) {
      const r = await tools[5].execute({ pattern, path: root }, ctx)
      if (!r.success || r.truncated || r.output !== expected
        || Buffer.from(r.output, 'utf8').toString('utf8').includes('�')) {
        throw new Error(`grep_code emoji 摘要异常 (${pattern}): ${JSON.stringify(r).slice(0, 300)}`)
      }
    }
  })
  await check('grep_code: 缓存命中后按文件变更刷新', async () => {
    const root = join(TMP, `grep-cache-${process.pid}-${Date.now()}`)
    const nested = join(root, 'nested')
    const file = join(nested, 'hit.txt')
    mkdirSync(nested, { recursive: true })
    writeFileSync(file, 'first NEEDLE\n')
    const search = (pattern: string, path = root) => tools[5].execute({ pattern, path }, ctx)
    const first = await search('NEEDLE')
    const cached = await search('NEEDLE')
    if (!first.success || cached.output !== first.output || !cached.output.includes('hit.txt:1:')) throw new Error(`缓存结果异常: ${JSON.stringify(cached)}`)
    writeFileSync(file, 'replacement text\n')
    const changed = await search('NEEDLE')
    if (!changed.success || !changed.output.includes('未找到')) throw new Error(`旧匹配未失效: ${JSON.stringify(changed)}`)
    writeFileSync(file, 'second NEEDLE\n')
    const restored = await search('NEEDLE', nested)
    if (!restored.success || !restored.output.startsWith('hit.txt:1:')) throw new Error(`相对路径异常: ${JSON.stringify(restored)}`)
    const regex = await search('^second NEEDLE$')
    if (!regex.success || !regex.output.includes('hit.txt:1:')) throw new Error(`正则匹配异常: ${JSON.stringify(regex)}`)
    await search('^second NEEDLE$')
    writeFileSync(file, 'third NEEDLE with changed size\n')
    const regexChanged = await search('^second NEEDLE$')
    if (!regexChanged.success || !regexChanged.output.includes('未找到')) throw new Error(`正则缓存未失效: ${JSON.stringify(regexChanged)}`)
  })

  mkdirSync(join(TMP, 'grep-empty'), { recursive: true })
  writeFileSync(join(TMP, 'grep-empty', 'blank.txt'), '\n\n', 'utf8')
  await check('grep_code: 纯文本快速路径不误匹配空行', async () => {
    const r = await tools[5].execute({ pattern: 'plain_literal', path: 'grep-empty' }, ctx)
    if (!r.success || r.output.includes('blank.txt')) throw new Error(`空行被误匹配: ${r.output}`)
  })

  writeFileSync(join(TMP, 'grep_large_early.txt'), `${Array.from({ length: 20 }, (_, i) => `EARLY_MATCH_${i}`).join('\n')}\n${'filler line\n'.repeat(200000)}`, 'utf8')
  await check('grep_code: 大文件达到单文件上限后返回 20 条', async () => {
    const r = await tools[5].execute({ pattern: 'EARLY_MATCH_' }, ctx)
    if (!r.success || r.truncated || r.output.split('\n').length !== 20) throw new Error(`结果不符: ${r.output.slice(0, 200)}`)
  })
  await check('grep_code: 单文件超过 20 条时才标记截断', async () => {
    const root = join(TMP, 'grep-per-file-limit')
    mkdirSync(root)
    const file = join(root, 'sample.txt')
    for (const pattern of ['LIMIT_MATCH_', '^LIMIT_MATCH_']) {
      for (const count of [19, 20, 21]) {
        writeFileSync(file, Array.from({ length: count }, (_, index) => `LIMIT_MATCH_${index}`).join('\n'))
        const r = await tools[5].execute({ pattern, path: root }, ctx)
        const lines = r.output.split('\n')
        const marker = count > 20 ? lines.pop() : undefined
        const expected = Array.from({ length: Math.min(count, 20) }, (_, index) => `sample.txt:${index + 1}: LIMIT_MATCH_${index}`)
        if (!r.success || r.truncated !== (count > 20) || marker !== (count > 20 ? '…[结果过多已截断]' : undefined)
          || lines.join('\n') !== expected.join('\n')) {
          throw new Error(`单文件上限异常 (${pattern}, ${count}): ${JSON.stringify(r).slice(0, 300)}`)
        }
      }
    }
  })
  await check('grep_code: 总命中超过 200 条时才标记截断', async () => {
    const root = join(TMP, 'grep-total-limit')
    mkdirSync(root)
    for (let index = 0; index < 19; index++) {
      writeFileSync(join(root, `${String(index).padStart(2, '0')}.txt`), 'HIT\n'.repeat(10))
    }
    for (const count of [199, 200, 201]) {
      writeFileSync(join(root, '19.txt'), 'HIT\n'.repeat(count === 199 ? 9 : 10))
      if (count === 201) writeFileSync(join(root, '20.txt'), 'HIT\n')
      for (const pattern of ['HIT', '^HIT']) {
        const r = await tools[5].execute({ pattern, path: root }, ctx)
        const lines = r.output.split('\n')
        const marker = count > 200 ? lines.pop() : undefined
        if (!r.success || r.truncated !== (count > 200) || marker !== (count > 200 ? '…[结果过多已截断]' : undefined)
          || lines.length !== Math.min(count, 200) || lines.some((line) => !/^\d{2}\.txt:\d+: HIT$/.test(line))) {
          throw new Error(`总结果上限异常 (${pattern}, ${count}): ${JSON.stringify(r).slice(0, 300)}`)
        }
      }
    }
  })
  writeFileSync(join(TMP, 'grep_utf8_boundary.txt'), `${'x'.repeat(3 * 1024 * 1024 - 4)}ABC中BOUNDARY_MATCH\n`, 'utf8')
  await check('grep_code: 长单行搜索保持 UTF-8 字符边界', async () => {
    const r = await tools[5].execute({ pattern: 'ABC中BOUNDARY_MATCH' }, ctx)
    if (!r.success || !r.output.includes('grep_utf8_boundary.txt:1:')) throw new Error(`结果不符: ${r.output.slice(0, 200)}`)
  })
  mkdirSync(join(TMP, 'grep-chunk-boundary'), { recursive: true })
  writeFileSync(join(TMP, 'grep-chunk-boundary', 'line.txt'), `${'x'.repeat(1024 * 1024 - 1)}中FINISH\n`, 'utf8')
  await check('grep_code: 正则匹配跨块 UTF-8 行', async () => {
    const r = await tools[5].execute({ pattern: '中FINISH$', path: 'grep-chunk-boundary' }, ctx)
    if (!r.success || !r.output.includes('line.txt:1:')) throw new Error(`跨块正则结果不符: ${r.output.slice(0, 200)}`)
  })
  writeFileSync(join(TMP, 'grep-chunk-boundary', 'literal.txt'), `${'x'.repeat(1024 * 1024 - 2)}AB\nCD\nABCD\n`, 'utf8')
  await check('grep_code: 字面量跨块不跨行匹配', async () => {
    const r = await tools[5].execute({ pattern: 'ABCD', path: 'grep-chunk-boundary' }, ctx)
    if (!r.success || !r.output.includes('literal.txt:3:') || r.output.includes('literal.txt:1:')) {
      throw new Error(`跨块字面量结果不符: ${r.output.slice(0, 200)}`)
    }
  })
  writeFileSync(join(TMP, 'grep-chunk-boundary', 'trailing.txt'), 'content\n', 'utf8')
  await check('grep_code: 正则匹配文件末尾空行', async () => {
    const r = await tools[5].execute({ pattern: '^$', path: 'grep-chunk-boundary' }, ctx)
    if (!r.success || !r.output.includes('trailing.txt:2:')) throw new Error(`末尾空行结果不符: ${r.output.slice(0, 200)}`)
  })

  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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
