import type { IncomingMessage, ServerResponse } from 'node:http'
import { MAX_BODY_BYTES } from './protocol.ts'

export interface AgentCardOptions {
  baseUrl?: string
  authToken?: string
  name?: string
  description?: string
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(statusCode, { 'content-type': 'application/a2a+json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  rpcId?: string | number | null,
  rpcCode?: number,
): void {
  if (rpcId !== undefined) {
    sendJson(response, statusCode, { jsonrpc: '2.0', id: rpcId, error: { code: rpcCode ?? -32000, message } })
    return
  }
  sendJson(response, statusCode, {
    error: { code: statusCode, status: message.toUpperCase().replaceAll(' ', '_'), message },
  })
}

export function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      raw += chunk.toString()
    })
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('JSON 解析失败'))
      }
    })
    request.on('error', reject)
  })
}

function baseUrl(request: IncomingMessage, configured?: string): string {
  if (configured) return configured.replace(/\/$/, '')
  return `http://${request.headers.host ?? '127.0.0.1'}`
}

export function agentCard(request: IncomingMessage, options: AgentCardOptions): Record<string, unknown> {
  const url = baseUrl(request, options.baseUrl)
  return {
    name: options.name ?? 'MeiCode Agent',
    description: options.description ?? 'MeiCode coding agent with tool execution and task streaming.',
    supportedInterfaces: [
      { url: `${url}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ],
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: false },
    defaultInputModes: ['text/plain', 'application/a2a+json'],
    defaultOutputModes: ['text/plain', 'application/a2a+json'],
    skills: [{
      id: 'meicode-coding-agent',
      name: 'MeiCode coding agent',
      description: '分析、修改、测试和验证代码项目。',
      tags: ['coding', 'debugging', 'testing'],
    }],
    ...(options.authToken ? {
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'opaque' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    } : {}),
    version: '0.1.0',
  }
}

export function isAuthorized(request: IncomingMessage, authToken?: string): boolean {
  return !authToken || request.headers.authorization === `Bearer ${authToken}`
}
