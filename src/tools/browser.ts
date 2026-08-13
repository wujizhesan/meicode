import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 浏览器自动化工具(对齐 Qoder navigate/click/execute_js/network):
// launch 启动系统 Edge(headless) / navigate 打开 URL / eval 执行 JS
// shot 截图(→ shot_diff 用) / click 点击 / close 关闭
// 采集(acquisition)、验证(verifier 截图)、复刻(DOM 对比)的通用能力

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
let browser: Browser | null = null
let page: Page | null = null

export const browserTool: Tool = {
  name: 'browser',
  description:
    '浏览器自动化(系统 Edge): launch=启动浏览器; navigate url=<地址> 打开页面; eval expr=<JS表达式> 执行并返回结果; shot path=<输出png> 截图(配合 shot_diff 对比); click sel=<CSS选择器> 点击; close=关闭。采集/验证/复刻通用。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'launch / navigate / eval / shot / click / close' },
      url: { type: 'string', description: 'navigate 用:目标地址' },
      expr: { type: 'string', description: 'eval 用:JS 表达式(如 document.title / document.querySelector(...).innerText)' },
      path: { type: 'string', description: 'shot 用:输出 PNG 路径' },
      sel: { type: 'string', description: 'click 用:CSS 选择器' },
      headless: { type: 'boolean', description: 'launch 用:无头模式(默认 true)' },
    },
    required: ['action'],
  },

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? '')

    if (action === 'launch') {
      if (browser) return { success: true, output: '浏览器已在运行' }
      try {
        browser = await chromium.launch({
          executablePath: EDGE_PATH,
          headless: args.headless !== false,
        })
        page = await browser.newPage()
        return { success: true, output: '✅ 浏览器已启动(系统 Edge)' }
      } catch (e) {
        return { success: false, output: '', error: `浏览器启动失败: ${(e as Error).message.slice(0, 200)}` }
      }
    }

    if (!browser || !page) return { success: false, output: '', error: '浏览器未启动(先 launch)' }

    if (action === 'navigate') {
      const url = String(args.url ?? '')
      if (!url) return { success: false, output: '', error: '缺少 url' }
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        return { success: true, output: `已打开 ${url}\n标题: ${await page.title()}` }
      } catch (e) {
        return { success: false, output: '', error: `导航失败: ${(e as Error).message.slice(0, 150)}` }
      }
    }

    if (action === 'eval') {
      const expr = String(args.expr ?? '')
      if (!expr) return { success: false, output: '', error: '缺少 expr' }
      try {
        const result = await page.evaluate(expr)
        const text = typeof result === 'object' ? JSON.stringify(result).slice(0, 2000) : String(result)
        return { success: true, output: text || '(空结果)' }
      } catch (e) {
        return { success: false, output: '', error: `执行失败: ${(e as Error).message.slice(0, 150)}` }
      }
    }

    if (action === 'shot') {
      const path = String(args.path ?? '')
      if (!path) return { success: false, output: '', error: '缺少 path' }
      try {
        await page.screenshot({ path, fullPage: false })
        return { success: true, output: `截图已保存: ${path}` }
      } catch (e) {
        return { success: false, output: '', error: `截图失败: ${(e as Error).message.slice(0, 150)}` }
      }
    }

    if (action === 'click') {
      const sel = String(args.sel ?? '')
      if (!sel) return { success: false, output: '', error: '缺少 sel' }
      try {
        await page.click(sel, { timeout: 10000 })
        return { success: true, output: `已点击 ${sel}` }
      } catch (e) {
        return { success: false, output: '', error: `点击失败: ${(e as Error).message.slice(0, 150)}` }
      }
    }

    if (action === 'close') {
      await browser.close()
      browser = null
      page = null
      return { success: true, output: '浏览器已关闭' }
    }

    return { success: false, output: '', error: `未知 action: ${action}(launch/navigate/eval/shot/click/close)` }
  },
}
