import type { Server } from 'node:http'
import { isIP } from 'node:net'
import type { A2aOptions } from '../a2a.ts'
import type { AcpOptions } from '../acp.ts'
import type { MemoryContext } from '../memory/index.ts'
import type { PermissionMode } from '../permission/types.ts'
import type { RuleEngine } from '../permission/index.ts'
import type { Provider } from '../provider/types.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { HookEngine } from '../hook/engine.ts'
import { buildMemoryTail } from '../memory/index.ts'
import { projectStatePath } from '../state-paths.ts'
import { settleCloseTask } from './close-timeout.ts'

interface ServiceEndpoint {
  port: number
  host?: string
  authToken?: string
  pushAllowedUrls?: string[]
}

function isLoopbackHost(host: string): boolean {
  return host.toLowerCase() === 'localhost' || host === '::1' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'))
}

export interface RuntimeServiceOptions {
  provider: Provider
  registry: ToolRegistry
  engine: RuleEngine
  cwd: string
  memory: MemoryContext
  contextWindow: number
  permissionMode: PermissionMode
  hooks?: HookEngine
  acp?: ServiceEndpoint
  a2a?: ServiceEndpoint
}

export interface RuntimeServiceFactories {
  createAcpServer(options: AcpOptions): Server
  createA2aServer(options: A2aOptions): Server
}

export interface RuntimeServiceHost {
  close(): Promise<void>
}

export function listenHttpServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      server.closeAllConnections()
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
  const drain = (server as Server & { drainPushNotifications?: (timeoutMs?: number, stopOnTimeout?: boolean) => Promise<boolean> }).drainPushNotifications
  if (typeof drain === 'function') await drain.call(server, undefined, true)
}

export function createRuntimeServiceHost(servers: Server[]): RuntimeServiceHost {
  let closing: Promise<void> | null = null
  return {
    close() {
      if (!closing) {
        closing = Promise.all(
          servers.map((server, index) => settleCloseTask(`HTTP 服务 ${index + 1}`, () => closeHttpServer(server))),
        ).then(() => undefined)
      }
      return closing
    },
  }
}

export async function startRuntimeServices(
  options: RuntimeServiceOptions,
  factories?: Partial<RuntimeServiceFactories>,
): Promise<RuntimeServiceHost> {
  const servers: Server[] = []
  const host = createRuntimeServiceHost(servers)
  try {
    if (options.acp) {
      const createAcpServer = factories?.createAcpServer ?? (await import('../acp.ts')).createAcpServer
      const bindHost = options.acp.host || '127.0.0.1'
      if (!isLoopbackHost(bindHost) && !options.acp.authToken?.trim()) {
        throw new Error('ACP 绑定非本机地址时必须配置 authToken')
      }
      const server = createAcpServer({
        provider: options.provider,
        registry: options.registry,
        engine: options.engine,
        cwd: options.cwd,
        memoryTail: buildMemoryTail(options.memory),
        authToken: options.acp.authToken,
        runtimeEvents: options.memory.runtimeEvents,
        contextWindow: options.contextWindow,
        permissionMode: options.permissionMode,
        hooks: options.hooks,
      })
      servers.push(server)
      await listenHttpServer(server, options.acp.port, bindHost)
      console.log(`[ACP] 服务已启动 ${bindHost}:${options.acp.port} (POST /session/new → /session/:id/prompt)`)
    }

    if (options.a2a) {
      const createA2aServer = factories?.createA2aServer ?? (await import('../a2a.ts')).createA2aServer
      const bindHost = options.a2a.host || '127.0.0.1'
      if (!isLoopbackHost(bindHost) && !options.a2a.authToken?.trim()) {
        throw new Error('A2A 绑定非本机地址时必须配置 authToken')
      }
      const server = createA2aServer({
        provider: options.provider,
        registry: options.registry,
        engine: options.engine,
        cwd: options.cwd,
        memoryTail: options.memory.instructions ?? '',
        baseUrl: `http://${bindHost}:${options.a2a.port}`,
        authToken: options.a2a.authToken,
        pushAllowedUrls: options.a2a.pushAllowedUrls,
        taskRoot: projectStatePath(options.cwd, 'a2a', 'tasks'),
        runtimeEvents: options.memory.runtimeEvents,
        contextWindow: options.contextWindow,
        permissionMode: options.permissionMode,
        hooks: options.hooks,
      })
      servers.push(server)
      await listenHttpServer(server, options.a2a.port, bindHost)
      console.log(`[A2A] 服务已启动:${bindHost}:${options.a2a.port} (GET /.well-known/agent-card.json)`)
    }

    return host
  } catch (error) {
    await host.close()
    throw error
  }
}
