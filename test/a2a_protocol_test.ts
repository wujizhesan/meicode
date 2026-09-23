import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  methodName,
  normalizePushAllowedUrls,
  normalizePushNotificationConfig,
  optionalInt,
  parseMessage,
  rpcRequest,
} from '../src/a2a/protocol.ts'
import { isAuthorized } from '../src/a2a/http.ts'
import type { IncomingMessage } from 'node:http'
import { A2aTaskStore } from '../src/a2a/store.ts'
import type { A2ATask } from '../src/a2a/types.ts'

let passed = 0
let failed = 0

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}: ${(error as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function expectError(run: () => unknown, message: string): void {
  try {
    run()
  } catch {
    return
  }
  throw new Error(message)
}

await check('parseMessage: 规范化用户文本消息', () => {
  const message = parseMessage({ role: 'user', contextId: 'ctx', parts: [{ text: 'hello' }, { text: 'world' }] })
  assert(message.role === 'ROLE_USER', '角色未规范化')
  assert(message.contextId === 'ctx' && message.parts.length === 2, '消息字段丢失')
  assert(message.messageId.length > 0, '未生成 messageId')
})

await check('parseMessage: 拒绝空消息与 Agent 消息', () => {
  expectError(() => parseMessage({ parts: [{ text: '   ' }] }), '空消息未被拒绝')
  expectError(() => parseMessage({ role: 'ROLE_AGENT', parts: [{ text: 'x' }] }), 'Agent 消息未被拒绝')
})

await check('normalizePushNotificationConfig: 限制远程 HTTP 与头注入', () => {
  const allowed = normalizePushAllowedUrls(['http://localhost:8787/hook', 'https://example.com/hook'])
  const local = normalizePushNotificationConfig({ url: 'http://localhost:8787/hook', token: 'safe' }, 'task-1', allowed)
  assert(local.taskId === 'task-1' && local.url === 'http://localhost:8787/hook', '本机 HTTP 未正确规范化')
  expectError(() => normalizePushNotificationConfig({ url: 'http://localhost:8787/hook' }, 'task-1'), '默认允许本机回调')
  expectError(() => normalizePushNotificationConfig({ url: 'http://localhost:8787/other' }, 'task-1', allowed), '非白名单路径未被拒绝')
  expectError(() => normalizePushNotificationConfig({ url: 'http://example.com/hook' }, 'task-1', allowed), '远程 HTTP 未被拒绝')
  expectError(() => normalizePushNotificationConfig({ url: 'https://example.com/hook', token: 'bad\r\nheader' }, 'task-1', allowed), '头注入 token 未被拒绝')
  expectError(() => normalizePushAllowedUrls(['http://example.com/hook']), '远程 HTTP 白名单未被拒绝')
})

await check('A2A 无 Token 只接受本机连接', () => {
  const request = (address: string, authorization?: string): IncomingMessage => ({
    socket: { remoteAddress: address },
    headers: authorization ? { authorization } : {},
  }) as unknown as IncomingMessage
  assert(isAuthorized(request('127.0.0.1')), '本机连接被拒绝')
  assert(isAuthorized(request('::1')), 'IPv6 本机连接被拒绝')
  assert(!isAuthorized(request('192.0.2.10')), '无 Token 远程连接被放行')
  assert(!isAuthorized(request('192.0.2.10'), 'secret'), '任意授权头绕过了无 Token 限制')
  assert(isAuthorized(request('192.0.2.10', 'Bearer secret'), 'secret'), '有效 Bearer token 未放行')
})

await check('JSON-RPC: 校验请求并统一方法别名', () => {
  const parsed = rpcRequest({ jsonrpc: '2.0', id: 7, method: 'message/send', params: { value: 1 } })
  assert(parsed.id === 7 && parsed.params.value === 1, 'JSON-RPC 请求解析失败')
  assert(methodName('SendMessage') === 'send' && methodName('message/send') === 'send', '方法别名不一致')
  assert(methodName('unknown') === '', '未知方法不应映射')
  expectError(() => rpcRequest({ jsonrpc: '1.0', id: 1, method: 'x' }), '错误版本未被拒绝')
})

await check('optionalInt: 接受边界值并拒绝非法值', () => {
  assert(optionalInt('10', 'pageSize', 100) === 10, '数字字符串解析失败')
  assert(optionalInt(undefined, 'pageSize', 100) === undefined, '可选值处理失败')
  expectError(() => optionalInt(-1, 'pageSize', 100), '负数未被拒绝')
  expectError(() => optionalInt(101, 'pageSize', 100), '超上限值未被拒绝')
})

await check('A2aTaskStore: 深拷贝持久化并支持删除', () => {
  const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-store-'))
  try {
    const task: A2ATask = {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(0).toISOString() },
      history: [{ messageId: 'message-1', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'original' }] }],
      artifacts: [],
    }
    const store = new A2aTaskStore(root)
    store.save(task, [{ id: 'push-1', taskId: task.id, url: 'https://example.com/hook' }])
    task.history[0].parts[0].text = 'mutated'
    const loaded = store.load()
    assert(loaded[0]?.task.history[0]?.parts[0]?.text === 'original', '持久化数据被外部修改')
    assert(loaded[0]?.pushNotificationConfigs[0]?.id === 'push-1', 'Push 配置未恢复')
    loaded[0].task.history[0].parts[0].text = 'cache-mutated'
    assert(store.load()[0]?.task.history[0]?.parts[0]?.text === 'original', '缓存被调用方修改')
    const peer = new A2aTaskStore(root)
    peer.save({ ...task, id: 'task-2', contextId: 'ctx-2' })
    assert(store.load().some((item) => item.task.id === 'task-2'), '缓存未识别跨实例写入')
    store.remove(task.id)
    assert(store.load().length === 1 && store.load()[0].task.id === 'task-2', '任务未删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('A2aTaskStore: 隔离损坏文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-corrupt-'))
  try {
    writeFileSync(join(root, 'tasks.json'), '{broken', 'utf8')
    const store = new A2aTaskStore(root)
    assert(store.load().length === 0, '损坏存储不应返回任务')
    assert(!existsSync(join(root, 'tasks.json')), '损坏文件未移走')
    assert(readdirSync(root).some((name) => name.startsWith('tasks.json.corrupt.')), '损坏备份未生成')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('A2aTaskStore: 迁移旧任务并只更新目标记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-migrate-'))
  try {
    const legacyTask: A2ATask = {
      id: 'legacy/../task',
      contextId: 'ctx-legacy',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(0).toISOString() },
      history: [],
      artifacts: [],
    }
    const otherTask: A2ATask = { ...legacyTask, id: 'task-other', contextId: 'ctx-other' }
    const legacyFile = join(root, 'tasks.json')
    writeFileSync(legacyFile, JSON.stringify([
      { ...legacyTask, contextId: 'ctx-stale' },
      legacyTask,
      { task: otherTask, pushNotificationConfigs: [{ id: 'push-other', taskId: otherTask.id, url: 'https://example.com/hook' }] },
    ]), 'utf8')
    const legacyContent = readFileSync(legacyFile, 'utf8')
    const recordsDir = join(root, 'records')
    mkdirSync(recordsDir)
    const partialRecord = join(recordsDir, `${createHash('sha256').update(legacyTask.id).digest('hex')}.json`)
    writeFileSync(partialRecord, JSON.stringify({ task: { ...legacyTask, contextId: 'ctx-partial' }, pushNotificationConfigs: [] }), 'utf8')
    const store = new A2aTaskStore(root)
    const migrated = store.load()
    assert(migrated.length === 2, '旧记录未完整迁移或重复任务未合并')
    assert(migrated.find((item) => item.task.id === legacyTask.id)?.task.contextId === 'ctx-legacy', '中断迁移或重复任务未保留最后版本')
    assert(migrated.find((item) => item.task.id === otherTask.id)?.pushNotificationConfigs[0]?.id === 'push-other', 'Push 配置迁移丢失')
    assert(readFileSync(legacyFile, 'utf8') === legacyContent, '旧文件不应被改写')
    const recordNames = readdirSync(recordsDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    assert(recordNames.length === 2, '未按任务创建独立记录')
    const otherRecord = recordNames.map((name) => join(recordsDir, name))
      .find((file) => JSON.parse(readFileSync(file, 'utf8')).task.id === otherTask.id)
    assert(otherRecord, '未找到其他任务的记录')
    const otherContent = readFileSync(otherRecord, 'utf8')
    store.save({ ...legacyTask, contextId: 'ctx-updated' })
    assert(readFileSync(otherRecord, 'utf8') === otherContent, '更新一个任务改写了其他记录')
    assert(readFileSync(legacyFile, 'utf8') === legacyContent, '更新任务改写了旧文件')
    store.remove(legacyTask.id)
    const restarted = new A2aTaskStore(root)
    assert(restarted.load().length === 1 && restarted.load()[0].task.id === otherTask.id, '已删除的旧任务在重启后复活')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('A2aTaskStore: 单条损坏记录不影响其他任务', () => {
  const root = mkdtempSync(join(tmpdir(), 'meicode-a2a-record-corrupt-'))
  try {
    const task: A2ATask = {
      id: 'task-valid',
      contextId: 'ctx-valid',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(0).toISOString() },
      history: [],
      artifacts: [],
    }
    const store = new A2aTaskStore(root)
    store.save(task)
    store.save({ ...task, id: 'task-corrupt' })
    const recordsDir = join(root, 'records')
    const corruptFile = readdirSync(recordsDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => join(recordsDir, name))
      .find((file) => JSON.parse(readFileSync(file, 'utf8')).task.id === 'task-corrupt')
    assert(corruptFile, '未找到待破坏的记录')
    writeFileSync(corruptFile, '{broken', 'utf8')
    const loaded = store.load()
    assert(loaded.length === 1 && loaded[0].task.id === task.id, '坏记录影响了健康任务')
    assert(!existsSync(corruptFile), '坏记录未被隔离')
    assert(readdirSync(recordsDir).some((name) => name.includes('.corrupt.')), '未保留坏记录备份')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log(`\na2a_protocol_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
