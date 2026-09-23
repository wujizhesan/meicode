import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import {
  createRuntimeServiceHost,
  listenHttpServer,
  startRuntimeServices,
} from '../src/runtime/service-host.ts'
import type { A2aOptions } from '../src/a2a.ts'
import type { AcpOptions } from '../src/acp.ts'
import type { RuleEngine } from '../src/permission/index.ts'
import type { Provider } from '../src/provider/types.ts'
import type { ToolRegistry } from '../src/tools/index.ts'
import type { HookEngine } from '../src/hook/engine.ts'

class FakeServer extends EventEmitter {
  listenCalls: Array<{ port: number; host: string }> = []
  closeCount = 0
  connectionCloseCount = 0
  private readonly listenError?: Error

  constructor(listenError?: Error) {
    super()
    this.listenError = listenError
  }

  listen(port: number, host: string, callback: () => void): this {
    this.listenCalls.push({ port, host })
    queueMicrotask(() => this.listenError ? this.emit('error', this.listenError) : callback())
    return this
  }

  closeAllConnections(): void {
    this.connectionCloseCount++
  }

  close(callback: () => void): this {
    this.closeCount++
    queueMicrotask(callback)
    return this
  }
}

const standalone = new FakeServer()
await listenHttpServer(standalone as unknown as Server, 4567, '127.0.0.2')
if (standalone.listenCalls[0]?.port !== 4567 || standalone.listenCalls[0]?.host !== '127.0.0.2') {
  throw new Error('HTTP listen arguments changed')
}

const idempotent = new FakeServer()
const idempotentHost = createRuntimeServiceHost([idempotent as unknown as Server])
await Promise.all([idempotentHost.close(), idempotentHost.close()])
if (idempotent.closeCount !== 1 || idempotent.connectionCloseCount !== 1) {
  throw new Error(`service close was not idempotent: ${idempotent.closeCount}/${idempotent.connectionCloseCount}`)
}

const acp = new FakeServer()
const a2a = new FakeServer()
let acpOptions: AcpOptions | undefined
let a2aOptions: A2aOptions | undefined
const hooks = {} as HookEngine
const originalLog = console.log
console.log = () => {}
try {
  const host = await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: { sessionId: 'session-test', instructions: 'project instructions' },
    contextWindow: 4096,
    permissionMode: 'unattended',
    hooks,
    acp: { port: 4101, host: '127.0.0.3', authToken: 'acp-token' },
    a2a: { port: 4102, authToken: 'a2a-token', pushAllowedUrls: ['https://example.com/hook'] },
  }, {
    createAcpServer: (options) => {
      acpOptions = options
      return acp as unknown as Server
    },
    createA2aServer: (options) => {
      a2aOptions = options
      return a2a as unknown as Server
    },
  })
  if (!acpOptions?.memoryTail?.includes('project instructions') || acpOptions.authToken !== 'acp-token') {
    throw new Error('ACP runtime options changed')
  }
  if (a2aOptions?.memoryTail !== 'project instructions' || a2aOptions.baseUrl !== 'http://127.0.0.1:4102' || a2aOptions.pushAllowedUrls?.[0] !== 'https://example.com/hook') {
    throw new Error('A2A runtime options changed')
  }
  if (acpOptions?.sessionId !== undefined || a2aOptions?.sessionId !== undefined) {
    throw new Error('协议服务错误继承了启动时交互会话 ID')
  }
  if (acpOptions?.hooks !== hooks || a2aOptions?.hooks !== hooks) throw new Error('HookEngine 未透传到协议服务')
  await host.close()
} finally {
  console.log = originalLog
}
if (acp.closeCount !== 1 || a2a.closeCount !== 1) throw new Error('runtime services were not closed')

const started = new FakeServer()
const failed = new FakeServer(new Error('address in use'))
let rejected = false
console.log = () => {}
try {
  await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: {},
    contextWindow: 4096,
    permissionMode: 'unattended',
    acp: { port: 4201 },
    a2a: { port: 4202 },
  }, {
    createAcpServer: () => started as unknown as Server,
    createA2aServer: () => failed as unknown as Server,
  })
} catch (error) {
  rejected = (error as Error).message === 'address in use'
} finally {
  console.log = originalLog
}
if (!rejected || started.closeCount !== 1 || failed.closeCount !== 1) {
  throw new Error('partial startup was not rolled back')
}

let insecureFactoryCalled = false
let insecureRejected = false
try {
  await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: {},
    contextWindow: 4096,
    permissionMode: 'unattended',
    acp: { port: 4301, host: '0.0.0.0' },
  }, {
    createAcpServer: () => {
      insecureFactoryCalled = true
      return new FakeServer() as unknown as Server
    },
  })
} catch (error) {
  insecureRejected = (error as Error).message.includes('authToken')
}
if (!insecureRejected || insecureFactoryCalled) throw new Error('ACP 无 Token 外网绑定未在启动前拒绝')

const authenticatedPublicServer = new FakeServer()
console.log = () => {}
try {
  const publicHost = await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: {},
    contextWindow: 4096,
    permissionMode: 'unattended',
    acp: { port: 4302, host: '0.0.0.0', authToken: 'secret' },
  }, { createAcpServer: () => authenticatedPublicServer as unknown as Server })
  if (authenticatedPublicServer.listenCalls[0]?.host !== '0.0.0.0') throw new Error('带 Token 的外网监听未启动')
  await publicHost.close()
} finally {
  console.log = originalLog
}

let insecureA2aFactoryCalled = false
let insecureA2aRejected = false
try {
  await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: {},
    contextWindow: 4096,
    permissionMode: 'unattended',
    a2a: { port: 4303, host: '0.0.0.0' },
  }, {
    createA2aServer: () => {
      insecureA2aFactoryCalled = true
      return new FakeServer() as unknown as Server
    },
  })
} catch (error) {
  insecureA2aRejected = (error as Error).message.includes('authToken')
}
if (!insecureA2aRejected || insecureA2aFactoryCalled) throw new Error('A2A 无 Token 外网绑定未在启动前拒绝')

let deceptiveHostRejected = false
try {
  await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: {},
    contextWindow: 4096,
    permissionMode: 'unattended',
    a2a: { port: 4305, host: '127.example.com' },
  }, { createA2aServer: () => new FakeServer() as unknown as Server })
} catch (error) {
  deceptiveHostRejected = (error as Error).message.includes('authToken')
}
if (!deceptiveHostRejected) throw new Error('伪装 127. 前缀的非本机主机未拒绝')

const authenticatedA2aServer = new FakeServer()
console.log = () => {}
try {
  const publicHost = await startRuntimeServices({
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    engine: {} as RuleEngine,
    cwd: process.cwd(),
    memory: {},
    contextWindow: 4096,
    permissionMode: 'unattended',
    a2a: { port: 4304, host: '0.0.0.0', authToken: 'secret' },
  }, { createA2aServer: () => authenticatedA2aServer as unknown as Server })
  if (authenticatedA2aServer.listenCalls[0]?.host !== '0.0.0.0') throw new Error('带 Token 的 A2A 外网监听未启动')
  await publicHost.close()
} finally {
  console.log = originalLog
}

console.log('service_host_test passed')
