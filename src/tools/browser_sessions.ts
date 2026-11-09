import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { resolveOnAbort } from './abort.ts'
import type { ToolContext } from './types.ts'

interface BrowserSession {
  browser: Browser
  page: Page
}

class BrowserLaunchCancelledError extends Error {
  constructor() {
    super('浏览器启动已取消')
  }
}

function scopeKey(ctx: ToolContext): string {
  const cwd = resolve(ctx.cwd)
  return JSON.stringify([ctx.sessionId ?? '', ctx.agentId ?? '', process.platform === 'win32' ? cwd.toLowerCase() : cwd])
}

export class BrowserSessionPool {
  private sessions = new Map<string, BrowserSession>()
  private launching = new Map<string, Promise<BrowserSession>>()
  private closing = new Map<string, Promise<void>>()
  private readonly launchBrowser: (headless: boolean) => Promise<Browser>

  constructor(launchBrowser: (headless: boolean) => Promise<Browser>) {
    this.launchBrowser = launchBrowser
  }

  get(ctx: ToolContext): BrowserSession | null {
    return this.sessions.get(scopeKey(ctx)) ?? null
  }

  async launch(ctx: ToolContext, headless: boolean): Promise<boolean> {
    if (ctx.signal?.aborted) throw new BrowserLaunchCancelledError()
    const key = scopeKey(ctx)
    const closing = this.closing.get(key)
    if (closing) {
      const closed = await resolveOnAbort(closing.then(() => true), ctx.signal, false)
      if (!closed || ctx.signal?.aborted) throw new BrowserLaunchCancelledError()
    }
    if (this.sessions.has(key)) return false
    const existing = this.launching.get(key)
    if (existing) {
      try {
        const session = await resolveOnAbort(existing, ctx.signal, null)
        if (!session || ctx.signal?.aborted) throw new BrowserLaunchCancelledError()
        return false
      } catch (error) {
        if (!(error instanceof BrowserLaunchCancelledError) || ctx.signal?.aborted) throw error
        if (this.launching.get(key) === existing) this.launching.delete(key)
        return this.launch(ctx, headless)
      }
    }

    const pending = (async (): Promise<BrowserSession> => {
      const browser = await this.launchBrowser(headless)
      try {
        if (ctx.signal?.aborted) throw new BrowserLaunchCancelledError()
        const page = await browser.newPage()
        if (ctx.signal?.aborted) throw new BrowserLaunchCancelledError()
        const session = { browser, page }
        this.sessions.set(key, session)
        browser.on('disconnected', () => {
          if (this.sessions.get(key) === session) this.sessions.delete(key)
        })
        return session
      } catch (error) {
        await browser.close().catch(() => {})
        throw error
      }
    })()
    this.launching.set(key, pending)
    void pending.then((session) => {
      if (this.launching.get(key) === pending) this.launching.delete(key)
      if (ctx.signal?.aborted && this.sessions.get(key) === session) void this.closeKey(key).catch(() => {})
    }, () => {
      if (this.launching.get(key) === pending) this.launching.delete(key)
    })
    const session = await resolveOnAbort(pending, ctx.signal, null)
    if (!session || ctx.signal?.aborted) {
      if (session && this.sessions.get(key) === session) await this.closeKey(key)
      throw new BrowserLaunchCancelledError()
    }
    return true
  }

  async close(ctx: ToolContext): Promise<boolean> {
    return this.closeKey(scopeKey(ctx))
  }

  async closeAll(): Promise<void> {
    const keys = new Set([...this.sessions.keys(), ...this.launching.keys(), ...this.closing.keys()])
    await Promise.all([...keys].map((key) => this.closeKey(key)))
  }

  private async closeKey(key: string): Promise<boolean> {
    const closing = this.closing.get(key)
    if (closing) {
      await closing
      return false
    }
    const pending = this.launching.get(key)
    if (pending) {
      try {
        await pending
      } catch {
        return false
      }
    }
    const session = this.sessions.get(key)
    if (!session) return false
    this.sessions.delete(key)
    const finish = Promise.resolve().then(() => session.browser.close())
    this.closing.set(key, finish)
    try {
      await finish
      return true
    } finally {
      if (this.closing.get(key) === finish) this.closing.delete(key)
    }
  }
}
