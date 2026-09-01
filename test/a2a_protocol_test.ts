import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  methodName,
  normalizePushNotificationConfig,
  optionalInt,
  parseMessage,
  rpcRequest,
} from '../src/a2a/protocol.ts'
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
  const local = normalizePushNotificationConfig({ url: 'http://localhost:8787/hook', token: 'safe' }, 'task-1')
  assert(local.taskId === 'task-1' && local.url === 'http://localhost:8787/hook', '本机 HTTP 未正确规范化')
  expectError(() => normalizePushNotificationConfig({ url: 'http://example.com/hook' }, 'task-1'), '远程 HTTP 未被拒绝')
  expectError(() => normalizePushNotificationConfig({ url: 'https://example.com', token: 'bad\r\nheader' }, 'task-1'), '头注入 token 未被拒绝')
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
    store.remove(task.id)
    assert(store.load().length === 0, '任务未删除')
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

console.log(`\na2a_protocol_test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
