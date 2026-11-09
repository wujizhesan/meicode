import assert from 'node:assert/strict'
import http from 'node:http'
import { createAcpServer } from '../src/acp.ts'
import { RuleEngine } from '../src/permission/rules.ts'
import type { ChatMessage, Provider, StreamEvent } from '../src/provider/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

class ProbeProvider implements Provider {
  readonly protocol = 'openai' as const
  readonly requests: ChatMessage[][] = []

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    this.requests.push([...messages])
    yield { type: 'text', text: '完成' }
    yield { type: 'done' }
  }
}

const provider = new ProbeProvider()
const server = createAcpServer({
  provider,
  registry: new ToolRegistry(),
  engine: new RuleEngine('unused-user', 'unused-project', 'unused-local'),
  cwd: process.cwd(),
  authToken: 'reservation-test',
  maxSessions: 2,
  maxConcurrentAgents: 1,
  maxBodyBytes: 128,
  sessionTtlMs: 10_000,
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('ACP 测试服务未监听')
const base = `http://127.0.0.1:${address.port}`
const headers = { authorization: 'Bearer reservation-test', 'content-type': 'application/json' }

async function newSession(): Promise<string> {
  const response = await fetch(`${base}/session/new`, { method: 'POST', headers })
  assert.equal(response.status, 200)
  return (await response.json() as { sessionId: string }).sessionId
}

async function prompt(sessionId: string, body: string): Promise<number> {
  const response = await fetch(`${base}/session/${sessionId}/prompt`, { method: 'POST', headers, body })
  await response.text()
  return response.status
}

function partialPrompt(sessionId: string, text: string) {
  const path = `/session/${sessionId}/prompt`
  const body = JSON.stringify({ text })
  let signalAdmitted!: () => void
  let signalClosed!: () => void
  const admitted = new Promise<void>((resolve) => { signalAdmitted = resolve })
  const closed = new Promise<void>((resolve) => { signalClosed = resolve })
  const onRequest = (incoming: http.IncomingMessage) => {
    if (incoming.url !== path) return
    server.off('request', onRequest)
    incoming.once('close', signalClosed)
    signalAdmitted()
  }
  server.on('request', onRequest)
  const request = http.request(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-length': Buffer.byteLength(body) },
  })
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    request.once('response', resolve)
    request.once('error', reject)
  })
  void response.catch(() => {})
  request.write(body.slice(0, 6))
  return { request, response, admitted, closed, finish: () => request.end(body.slice(6)) }
}

try {
  const firstId = await newSession()
  let secondId = await newSession()

  const first = partialPrompt(firstId, 'first')
  await first.admitted
  assert.equal(await prompt(firstId, JSON.stringify({ text: 'duplicate' })), 409)
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'over capacity' })), 429)
  assert.equal(provider.requests.length, 0)
  const evictedId = secondId
  secondId = await newSession()
  assert.equal(await prompt(evictedId, JSON.stringify({ text: 'evicted' })), 404)
  assert.equal(await prompt(firstId, JSON.stringify({ text: 'still reserved' })), 409)
  first.finish()
  const firstResponse = await first.response
  assert.equal(firstResponse.statusCode, 200)
  for await (const _ of firstResponse) {}
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'after first' })), 200)
  assert.equal(provider.requests.length, 2)

  assert.equal(await prompt(firstId, '{'), 400)
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'after malformed' })), 200)
  assert.equal(await prompt(firstId, JSON.stringify({ text: 'x'.repeat(200) })), 413)
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'after oversized' })), 200)

  const aborted = partialPrompt(firstId, 'aborted')
  await aborted.admitted
  aborted.request.destroy()
  await aborted.closed
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'after disconnect' })), 200)

  const cancelled = partialPrompt(firstId, 'cancelled')
  await cancelled.admitted
  const cancelResponse = await fetch(`${base}/session/${firstId}/cancel`, { method: 'POST', headers })
  assert.equal(cancelResponse.status, 200)
  cancelled.request.destroy()
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'after cancel' })), 200)

  const closing = partialPrompt(firstId, 'closing')
  await closing.admitted
  const closeResponse = await fetch(`${base}/session/${firstId}/close`, { method: 'POST', headers })
  assert.equal(closeResponse.status, 202)
  closing.request.destroy()
  assert.equal(await prompt(secondId, JSON.stringify({ text: 'after close' })), 200)
  assert.equal(await prompt(firstId, JSON.stringify({ text: 'closed' })), 404)
  assert.equal(provider.requests.length, 7)
  console.log('acp_prompt_reservation_test passed')
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
