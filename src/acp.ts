import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Provider } from './provider/types.ts'
import { History } from './session/history.ts'
import type { ToolRegistry, ToolContext } from './tools/index.ts'
import type { RuleEngine } from './permission/index.ts'
import { runAgent } from './agent/loop.ts'
import { buildPrompt } from './agent/prompt/index.ts'

// ACP(Agent Client Protocol)服务端——MeiCode 的编程入口:
// 脚本/其他工具通过标准 HTTP+SSE 协议驱动 agent(流式事件/多会话/取消)
// 端点:
//   POST /session/new                    → {sessionId}
//   POST /session/:id/prompt {text}      → SSE 事件流(text/tool_call/done/error)
//   POST /session/:id/cancel             → 取消当前执行
//   GET  /health                         → {ok}

interface AcpSession {
  history: History
  agent?: ReturnType<typeof runAgent>
  controller?: AbortController
}

export interface AcpOptions {
  provider: Provider
  registry: ToolRegistry
  engine: RuleEngine
  cwd: string
  memoryTail?: string
}

export function createAcpServer(opts: AcpOptions): ReturnType<typeof createServer> {
  const sessions = new Map<string, AcpSession>()

  const sendJson = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          reject(new Error('JSON 解析失败'))
        }
      })
      req.on('error', reject)
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)

    try {
      // POST /session/new
      if (req.method === 'POST' && parts[0] === 'session' && parts[1] === 'new') {
        const id = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        sessions.set(id, { history: new History(), controller: new AbortController() })
        return sendJson(res, 200, { sessionId: id })
      }

      // GET /health
      if (req.method === 'GET' && parts[0] === 'health') {
        return sendJson(res, 200, { ok: true, sessions: sessions.size })
      }

      // POST /session/:id/cancel
      if (req.method === 'POST' && parts[0] === 'session' && parts[2] === 'cancel') {
        const s = sessions.get(parts[1])
        if (s) s.controller?.abort()
        return sendJson(res, 200, { ok: true })
      }

      // POST /session/:id/prompt → SSE
      if (req.method === 'POST' && parts[0] === 'session' && parts[2] === 'prompt') {
        const s = sessions.get(parts[1])
        if (!s) return sendJson(res, 404, { error: '会话不存在' })
        if (s.agent) return sendJson(res, 409, { error: '会话忙(先 cancel 或等完成)' })
        const body = await readBody(req)
        const text = String(body.text ?? '')
        if (!text) return sendJson(res, 400, { error: '缺少 text' })

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)

        s.history.push({ role: 'user', content: text })
        const ctx: ToolContext = {
          cwd: opts.cwd,
          timeoutMs: 30000,
          permission: { mode: 'permissive', engine: opts.engine, autoAcceptEdits: true },
        }
        const controller = new AbortController()
        s.controller = controller
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
            send('done', { reason: result.reason, rounds: result.rounds, tokens: result.totalTokens, errorMessage: result.errorMessage })
          } catch (e) {
            send('error', { message: (e as Error).message })
          } finally {
            s.agent = undefined
            s.controller = undefined
            res.end()
          }
        })()

        // 客户端断开时取消
        req.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        return
      }

      return sendJson(res, 404, { error: '未知端点' })
    } catch (e) {
      return sendJson(res, 500, { error: (e as Error).message })
    }
  })

  return server
}
