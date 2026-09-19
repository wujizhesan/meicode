import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
// 用 typescript5(独立依赖,API 稳定)——项目编译用 TS7,代码智能用 TS5
import type ts from 'typescript5'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 代码智能工具(TS LanguageService 直接集成,零外部进程):
// defs=符号定义位置 / refs=符号引用 / diagnostics=文件诊断(错误/警告)
// 对 TS/JS 项目立即可用——改代码时快速定位、查编译错误

interface CachedScript {
  version: number
  text: string
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
}

const MAX_SERVICE_CACHE = 4
interface ServiceEntry {
  service: ts.LanguageService
  refreshFiles: () => void
  configFile?: string
  configStamp: string
}

const serviceCache = new Map<string, ServiceEntry>()

function fileStamp(file: string | undefined): string {
  if (!file) return ''
  try {
    const stats = statSync(file)
    return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`
  } catch {
    return ''
  }
}

function createService(cwd: string, typescript: typeof ts): Pick<ServiceEntry, 'service' | 'refreshFiles'> {
  const files = new Map<string, CachedScript>()
  const tsconfig = typescript.findConfigFile(cwd, typescript.sys.fileExists)
  const parsedConfig = tsconfig ? typescript.getParsedCommandLineOfConfigFile(tsconfig, {}, typescript.sys as never) : undefined
  const options: ts.CompilerOptions = parsedConfig?.options ?? {}
  let scriptFileNames = parsedConfig?.fileNames ?? []
  const refreshFiles = () => {
    if (!tsconfig) return
    scriptFileNames = typescript.getParsedCommandLineOfConfigFile(tsconfig, {}, typescript.sys as never)?.fileNames ?? []
  }
  const loadScript = (fileName: string): CachedScript | undefined => {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(fileName)
    } catch {
      files.delete(fileName)
      return undefined
    }
    const cached = files.get(fileName)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.ino === stats.ino) return cached
    try {
      const script = {
        version: cached ? cached.version + 1 : 0,
        text: readFileSync(fileName, 'utf8'),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        ino: stats.ino,
      }
      files.set(fileName, script)
      return script
    } catch {
      files.delete(fileName)
      return undefined
    }
  }
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => {
      if (tsconfig) {
        return [...scriptFileNames]
      }
      // 无 tsconfig:扫描 cwd 下 TS/JS
      const out: string[] = []
      const walk = (dir: string, depth: number) => {
        if (depth > 4) return
        for (const f of typescript.sys.readDirectory(dir, ['.ts', '.tsx', '.js', '.jsx'])) {
          if (f.includes('node_modules') || f.includes('.mewcode')) continue
          out.push(f)
        }
      }
      walk(cwd, 0)
      return out
    },
    getScriptVersion: (fileName) => String(loadScript(fileName)?.version ?? 0),
    getScriptSnapshot: (fileName) => {
      const script = loadScript(fileName)
      return script ? typescript.ScriptSnapshot.fromString(script.text) : undefined
    },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => typescript.getDefaultLibFilePath(o),
    fileExists: typescript.sys.fileExists,
    readFile: typescript.sys.readFile,
    readDirectory: typescript.sys.readDirectory,
    directoryExists: typescript.sys.directoryExists,
    getDirectories: typescript.sys.getDirectories,
  }
  return { service: typescript.createLanguageService(host, typescript.createDocumentRegistry()), refreshFiles }
}

function getService(cwd: string, typescript: typeof ts): ts.LanguageService {
  const absolute = resolve(cwd)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const configFile = typescript.findConfigFile(absolute, typescript.sys.fileExists)
  const configStamp = fileStamp(configFile)
  const cached = serviceCache.get(key)
  if (cached && cached.configFile === configFile && cached.configStamp === configStamp) {
    cached.refreshFiles()
    serviceCache.delete(key)
    serviceCache.set(key, cached)
    return cached.service
  }
  cached?.service.dispose()
  const created = createService(absolute, typescript)
  serviceCache.set(key, { ...created, configFile, configStamp })
  if (serviceCache.size > MAX_SERVICE_CACHE) {
    const oldest = serviceCache.entries().next().value as [string, { service: ts.LanguageService }] | undefined
    if (oldest) {
      serviceCache.delete(oldest[0])
      oldest[1].service.dispose()
    }
  }
  return created.service
}

export const codeIntelTool: Tool = {
  name: 'code_intel',
  description:
    '代码智能(TS/JS 项目): defs=查符号定义位置 file=<文件> sym=<符号名>; refs=查符号引用; diagnostics=查文件诊断(编译错误/警告) file=<文件>。改代码前用 defs 定位、改完用 diagnostics 验证。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'defs / refs / diagnostics' },
      file: { type: 'string', description: '目标文件路径(defs/refs/diagnostics 用)' },
      sym: { type: 'string', description: '符号名(defs/refs 用)' },
      line: { type: 'number', description: '符号所在行(1 起,defs/refs 用,优先于 sym)' },
    },
    required: ['action'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? '')
    const file = args.file ? resolve(ctx.cwd, String(args.file)) : undefined
    const sym = typeof args.sym === 'string' ? args.sym : ''
    const line = typeof args.line === 'number' ? args.line : 0

    if (file && !existsSync(file)) return { success: false, output: '', error: `文件不存在: ${file}` }

    try {
      const { default: typescript } = await import('typescript5')
      const svc = getService(ctx.cwd, typescript)

      if (action === 'diagnostics') {
        if (!file) return { success: false, output: '', error: 'diagnostics 需要 file' }
        const synt = svc.getSyntacticDiagnostics(file)
        const sem = svc.getSemanticDiagnostics(file)
        const all = [...synt, ...sem]
        if (all.length === 0) return { success: true, output: '✅ 无诊断错误' }
        const lines = all.slice(0, 50).map((d) => {
          const pos = d.start ?? 0
          const lc = d.file?.getLineAndCharacterOfPosition(pos)
          const msg = typescript.flattenDiagnosticMessageText(d.messageText, '\n')
          return `${d.file?.fileName.split(/[\\/]/).pop()}:${(lc?.line ?? 0) + 1}:${(lc?.character ?? 0) + 1} [${d.category === 1 ? 'error' : 'warning'}] ${msg.slice(0, 150)}`
        })
        return { success: true, output: `${all.length} 个诊断:\n${lines.join('\n')}` }
      }

      if (action === 'defs' || action === 'refs') {
        if (!file) return { success: false, output: '', error: `${action} 需要 file` }
        // 定位符号:优先行号,其次符号名查找
        const text = readFileSync(file, 'utf8')
        let pos = 0
        if (line > 0) {
          const linesArr = text.split('\n')
          const target = linesArr[Math.min(line - 1, linesArr.length - 1)] ?? ''
          pos = linesArr.slice(0, line - 1).join('\n').length + 1
          // 找行内标识符
          const m = target.match(/[A-Za-z_$][\w$]*/g)
          if (m && m.length > 0) pos += target.indexOf(m[0]) + Math.floor(m[0].length / 2)
        } else if (sym) {
          const idx = text.indexOf(sym)
          if (idx < 0) return { success: false, output: '', error: `符号 ${sym} 未在文件中找到` }
          pos = idx + Math.floor(sym.length / 2)
        } else {
          return { success: false, output: '', error: '需要 sym 或 line' }
        }

        const loc = svc.getDefinitionAtPosition(file, pos)
        if (!loc || loc.length === 0) return { success: false, output: '', error: '未找到定义(符号可能是内置/外部)' }
        const show = loc.slice(0, 20).map((d) => {
          const src = d.fileName ? typescript.createSourceFile(d.fileName, existsSync(d.fileName) ? readFileSync(d.fileName, "utf8") : "", typescript.ScriptTarget.Latest, false) : null; const lc = src?.getLineAndCharacterOfPosition(d.textSpan.start)
          return `${d.fileName.split(/[\\/]/).pop()}:${(lc?.line ?? 0) + 1}`
        })
        if (action === 'defs') {
          return { success: true, output: `定义(${loc.length} 处):\n${show.join('\n')}` }
        }
        const refs = svc.findReferences(file, pos) ?? []
        const lines = refs.slice(0, 30).map((r) => {
          const items = r.references.slice(0, 5).map((ref) => ref.fileName.split(/[\\/]/).pop())
          return `${r.definition.fileName.split(/[\\/]/).pop()}: ${items.join(', ')}`
        })
        return { success: true, output: `引用(${refs.length} 组):\n${lines.join('\n') || '(无)'}` }
      }

      return { success: false, output: '', error: `未知 action: ${action}(defs/refs/diagnostics)` }
    } catch (e) {
      return { success: false, output: '', error: `代码智能失败: ${(e as Error).message.slice(0, 200)}` }
    }
  },
}
