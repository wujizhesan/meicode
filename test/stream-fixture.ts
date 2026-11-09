import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { HookEngine } from '../src/hook/engine.ts'
import { SessionStore } from '../src/memory/index.ts'
import { RuleEngine } from '../src/permission/index.ts'
import type { Provider } from '../src/provider/types.ts'
import { History } from '../src/session/history.ts'
import { SubAgentManager, SubAgentStore } from '../src/subagent/index.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { useStreamingChat } from '../src/tui/useStream.ts'

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

export const tick = () => new Promise<void>((done) => setImmediate(done))

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('流式会话回归超时')), 3000)
    })])
  } finally { clearTimeout(timer) }
}

export async function streamFixture(provider: Provider, options: {
  hooks?: HookEngine; onSessionChange?: (id: string) => void
} = {}) {
  const previousCwd = process.cwd()
  const root = mkdtempSync(join(import.meta.dirname, 'fixtures_stream_fixture_'))
  process.chdir(root)
  const history = new History()
  const registry = new ToolRegistry()
  const store = new SessionStore(join(root, 'sessions'))
  const memory = { sessionStore: store, sessionId: 'stream-test' }
  const roles = join(root, 'roles')
  mkdirSync(roles)
  writeFileSync(join(roles, 'probe.md'), '---\nname: probe\ndescription: 回归角色\npermission: permissive\n---\nSTREAM-CHILD-PROBE\n')
  const subStore = new SubAgentStore(join(root, 'subagents'), memory.sessionId)
  const manager = new SubAgentManager({ builtin: join(root, 'none'), user: join(root, 'none'), project: roles }, undefined, subStore)
  manager.loadRoles()
  const engine = new RuleEngine(join(root, 'rules-user'), join(root, 'rules-project'), join(root, 'rules-local'))
  const hooks = options.hooks ?? new HookEngine([])
  registry.register({ name: 'read_file', description: '回归读取', parameters: { type: 'object' }, async execute() { return { success: true, output: 'STREAM-READ' } } })
  let chat!: ReturnType<typeof useStreamingChat>
  function Harness() {
    chat = useStreamingChat(provider, history, registry, engine, async () => 'once', undefined, undefined, 131072, memory, null, hooks, manager, null, (id) => {
      options.onSessionChange?.(id)
      manager.setSession(id)
    })
    return null
  }
  const output = new PassThrough()
  output.resume()
  const input = new PassThrough()
  const mount = () => render(createElement(Harness), {
    stdout: output as unknown as typeof process.stdout,
    stderr: output as unknown as typeof process.stderr,
    stdin: input as unknown as typeof process.stdin,
    patchConsole: false, exitOnCtrlC: false, interactive: false,
  })
  let app = mount()
  let mounted = true
  await tick()
  await tick()
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    const exited = app.waitUntilExit()
    app.unmount()
    await bounded(exited)
    await tick()
  }
  return {
    get chat() { return chat }, root, history, registry, store, memory, manager, subStore,
    async child(prompt: string, type: 'fork' | 'defined' = 'defined') {
      const submitted = await manager.spawn({ type, role: type === 'defined' ? 'probe' : undefined, prompt, async: true,
        ...(type === 'fork' ? { parentHistory: history.all(), parentTools: registry.list() } : {}),
      }, { provider, registry, ctx: chat.getToolContext() })
      return submitted.id
    },
    async finished(id: string, sessionId = manager.listRecords().find((record) => record.id === id)?.sessionId) {
      const result = await bounded(manager.waitFor(id, 2000, sessionId))
      await tick()
      await tick()
      return result.record!
    },
    unmount,
    async remount() { await unmount(); app = mount(); mounted = true; await tick(); await tick() },
    async close() {
      chat.cancel()
      await bounded(manager.close(0))
      await unmount()
      input.destroy()
      output.destroy()
      process.chdir(previousCwd)
      const target = resolve(root)
      assert(target.startsWith(resolve(import.meta.dirname) + sep + 'fixtures_stream_fixture_'))
      const verify = (directory: string) => {
        assert(!lstatSync(directory).isSymbolicLink())
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          assert(!entry.isSymbolicLink())
          if (entry.isDirectory()) verify(join(directory, entry.name))
        }
      }
      verify(target)
      rmSync(target, { recursive: true, force: true })
    },
  }
}
