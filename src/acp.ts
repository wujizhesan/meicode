import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Provider } from './provider/types.ts'
import { History } from './session/history.ts'
import type { ToolRegistry } from './tools/index.ts'
import type { RuleEngine } from './permission/index.ts'
import type { PermissionMode } from './permission/types.ts'
import { runAgent } from './agent/loop.ts'
import { buildPrompt } from './agent/prompt/index.ts'
import { createAgentRuntimeContext, createRuntimeId, recordAudit } from './runtime/index.ts'
import type { RuntimeEventLog } from './runtime/index.ts'
import type { HookEngine } from './hook/engine.ts'

// ACP(Agent Client Protocol)服务端——MeiCode 的编程入口:
// 脚本/其他工具通过标准 HTTP+SSE 协议驱动 agent(流式事件/多会话/取消)
// 端点:
//   POST /session/new                    → {sessionId}
//   POST /session/:id/prompt {text}      → SSE 事件流(text/tool_call/done/error)
//   POST /session/:id/cancel             → 取消当前执行
//   POST /session/:id/close              → 关闭会话并释放额度
//   GET  /health                         → {ok}

interface AcpSession {
  history: History
  agentId: string
  lastActivity: number
  initializing: boolean
  agent?: ReturnType<typeof runAgent>
  timer?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
}

export interface AcpOptions {
  provider: Provider
  registry: ToolRegistry
  engine: RuleEngine
  cwd: string
  memoryTail?: string
  authToken?: string
  maxBodyBytes?: number
  maxSessions?: number
  maxConcurrentAgents?: number
  sessionTtlMs?: number
  runtimeEvents?: RuntimeEventLog
  sessionId?: string
  contextWindow?: number
  permissionMode?: PermissionMode
  hooks?: HookEngine
}

export function createAcpServer(opts: AcpOptions): ReturnType<typeof createServer> {
  const sessions = new Map<string, AcpSession>()
  const maxBodyBytes = opts.maxBodyBytes ?? 2 * 1024 * 1024
  const maxSessions = opts.maxSessions ?? 32
  const maxConcurrentAgents = opts.maxConcurrentAgents ?? 4
  const sessionTtlMs = opts.sessionTtlMs ?? 24 * 60 * 60 * 1000
  let activeAgents = 0
  let closed = false
  let activityCounter = 0
  const scopeSessionId = (id: string): string => opts.sessionId ?? id

  const sendJson = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let raw = ''
      let size = 0
      let settled = false
      req.on('data', (c) => {
        if (settled) return
        size += Buffer.byteLength(c)
        if (size > maxBodyBytes) {
          settled = true
          const error = new Error('请求体过大') as Error & { statusCode?: number }
          error.statusCode = 413
          reject(error)
          return
        }
        raw += c
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          reject(new Error('JSON 解析失败'))
        }
      })
      req.on('error', reject)
    })

  const finishSession = async (id: string, session: AcpSession): Promise<void> => {
    if (session.closing) return session.closing
    if (session.timer) clearTimeout(session.timer)
    sessions.delete(id)
    const scopedId = scopeSessionId(id)
    const agent = session.agent
    agent?.cancel()
    session.closing = (async () => {
      try {
        await agent?.done.catch(() => undefined)
        await opts.hooks?.fire('session_end', { cwd: opts.cwd, sessionId: scopedId })
      } finally {
        opts.hooks?.clearSession(scopedId)
        opts.engine.clearSessionRules(scopedId)
        if (scopedId !== id) {
          opts.hooks?.clearSession(id)
          opts.engine.clearSessionRules(id)
        }
      }
    })()
    return session.closing
  }

  const touch = (id: string, session: AcpSession): void => {
    if (closed || sessions.get(id) !== session) return
    session.lastActivity = ++activityCounter
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      if (session.agent) {
        session.agent.cancel()
        touch(id, session)
        return
      }
      void finishSession(id, session)
    }, sessionTtlMs)
  }

  const authorized = (req: IncomingMessage): boolean => {
    if (!opts.authToken) {
      const address = req.socket.remoteAddress ?? ''
      return address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address)
    }
    return req.headers.authorization === `Bearer ${opts.authToken}`
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const requestHeader = req.headers['x-request-id']
    const requestId = typeof requestHeader === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(requestHeader) ? requestHeader : createRuntimeId('request')
    res.setHeader('x-request-id', requestId)

    try {
      if (!authorized(req)) {
        recordAudit(opts.runtimeEvents, { kind: 'acp_auth_rejected', sessionId: opts.sessionId ?? 'acp', requestId, level: 'warn', payload: { method: req.method, path: url.pathname } })
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        res.end(JSON.stringify({ error: '需要 Bearer token' }))
        return
      }

      // POST /session/new
      if (req.method === 'POST' && parts[0] === 'session' && parts[1] === 'new') {
        let evicted: Promise<void> | undefined
        if (sessions.size >= maxSessions) {
          let oldest: [string, AcpSession] | undefined
          for (const entry of sessions) {
            if (entry[1].agent || entry[1].closing || entry[1].initializing) continue
            if (!oldest || entry[1].lastActivity < oldest[1].lastActivity) oldest = entry
          }
          if (!oldest) return sendJson(res, 429, { error: '会话数量已达上限，且没有可回收的空闲会话' })
          evicted = finishSession(...oldest)
        }
        const id = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const session: AcpSession = { history: new History(), agentId: createRuntimeId('agent'), lastActivity: 0, initializing: true }
        sessions.set(id, session)
        touch(id, session)
        try {
          await evicted?.catch((error: unknown) => console.warn(`[ACP] 回收空闲会话失败: ${(error as Error).message}`))
          await opts.hooks?.fire('session_start', { cwd: opts.cwd, sessionId: scopeSessionId(id) })
          recordAudit(opts.runtimeEvents, { kind: 'acp_session_created', sessionId: opts.sessionId ?? id, taskId: id, requestId, payload: { protocol: 'acp' } })
          sendJson(res, 200, { sessionId: id })
          session.initializing = false
          return
        } catch (error) {
          void finishSession(id, session).catch((cleanupError: unknown) => console.warn(`[ACP] 清理创建失败会话异常: ${(cleanupError as Error).message}`))
          throw error
        }
      }

      // GET /health
      if (req.method === 'GET' && parts[0] === 'health') {
        return sendJson(res, 200, { ok: true, sessions: sessions.size })
      }

      // POST /session/:id/cancel
      if (req.method === 'POST' && parts[0] === 'session' && parts[2] === 'cancel') {
        const s = sessions.get(parts[1])
        s?.agent?.cancel()
        recordAudit(opts.runtimeEvents, { kind: 'acp_cancel_requested', sessionId: opts.sessionId ?? parts[1], taskId: parts[1], requestId, payload: { found: Boolean(s) } })
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'POST' && parts[0] === 'session' && parts[2] === 'close') {
        const session = sessions.get(parts[1])
        if (!session) return sendJson(res, 404, { error: '会话不存在' })
        const active = Boolean(session.agent)
        const closing = finishSession(parts[1], session)
        if (active) {
          void closing.catch((error: unknown) => console.warn(`[ACP] 关闭会话失败: ${(error as Error).message}`))
          return sendJson(res, 202, { ok: true, closing: true })
        }
        await closing
        return sendJson(res, 200, { ok: true })
      }

      // POST /session/:id/prompt → SSE
      if (req.method === 'POST' && parts[0] === 'session' && parts[2] === 'prompt') {
        const s = sessions.get(parts[1])
        if (!s) return sendJson(res, 404, { error: '会话不存在' })
        if (s.agent) return sendJson(res, 409, { error: '会话忙(先 cancel 或等完成)' })
        if (activeAgents >= maxConcurrentAgents) {
          recordAudit(opts.runtimeEvents, { kind: 'acp_concurrency_rejected', sessionId: opts.sessionId ?? parts[1], taskId: parts[1], requestId, level: 'warn', payload: { activeAgents, maxConcurrentAgents } })
          return sendJson(res, 429, { error: '并发 Agent 数量已达上限' })
        }
        touch(parts[1], s)
        const body = await readBody(req)
        const text = String(body.text ?? '')
        if (!text) return sendJson(res, 400, { error: '缺少 text' })

        const agentId = s.agentId
        const auditSessionId = opts.sessionId ?? parts[1]
        const startedAt = Date.now()
        recordAudit(opts.runtimeEvents, { kind: 'acp_prompt_started', sessionId: auditSessionId, agentId, taskId: parts[1], requestId, payload: { textLength: text.length } })

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)

        s.history.push({ role: 'user', content: text })
        const ctx = createAgentRuntimeContext({
          provider: opts.provider,
          history: s.history,
          engine: opts.engine,
          cwd: opts.cwd,
          sessionId: auditSessionId,
          agentId,
          runtimeEvents: opts.runtimeEvents,
          contextWindow: opts.contextWindow,
          permissionMode: opts.permissionMode,
          hooks: opts.hooks,
        })
        activeAgents++
        try {
          s.agent = runAgent({
            provider: opts.provider,
            history: s.history,
            registry: opts.registry,
            ctx,
            maxIterations: 20,
            mode: 'full',
            systemPrompt: buildPrompt('full') + (opts.memoryTail ?? ''),
            unknownToolLimit: 2,
          })
        } catch (error) {
          activeAgents--
          throw error
        }

        // 事件转发到 SSE
        void (async () => {
          try {
            for await (const ev of s.agent!.events) {
              if (ev.type === 'text') send('user_message_chunk', { text: ev.text })
              else if (ev.type === 'tool_call') send('tool_call', { name: ev.name, args: ev.args })
              else if (ev.type === 'tool_result') send('tool_result', { name: ev.name, success: ev.success })
              else if (ev.type === 'progress') send('progress', { round: ev.round })
            }
            const result = await s.agent!.done
            recordAudit(opts.runtimeEvents, { kind: 'acp_prompt_finished', sessionId: auditSessionId, agentId, taskId: parts[1], requestId, payload: { durationMs: Date.now() - startedAt, reason: result.reason, rounds: result.rounds, totalTokens: result.totalTokens } })
            send('done', { reason: result.reason, rounds: result.rounds, tokens: result.totalTokens, errorMessage: result.errorMessage })
          } catch (e) {
            recordAudit(opts.runtimeEvents, { kind: 'acp_prompt_failed', sessionId: auditSessionId, agentId, taskId: parts[1], requestId, level: 'error', payload: { durationMs: Date.now() - startedAt, error: (e as Error).message } })
            send('error', { message: (e as Error).message })
          } finally {
            s.agent = undefined
            activeAgents = Math.max(0, activeAgents - 1)
            touch(parts[1], s)
            res.end()
          }
        })()

        // 客户端断开时取消
        res.on('close', () => {
          if (!res.writableEnded) s.agent?.cancel()
        })
        return
      }

      return sendJson(res, 404, { error: '未知端点' })
    } catch (e) {
      const error = e as Error & { statusCode?: number }
      return sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  })

  server.on('close', () => {
    closed = true
    for (const [id, session] of sessions) {
      void finishSession(id, session)
    }
    activeAgents = 0
  })

  return server
}
