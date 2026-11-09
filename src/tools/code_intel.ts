import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'
// 用 typescript5(独立依赖,API 稳定)——项目编译用 TS7,代码智能用 TS5
import type ts from 'typescript5'
import { resolveOnAbort } from './abort.ts'
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
const MAX_DIAGNOSTIC_RESULTS = 50
const MAX_DEFINITION_RESULTS = 20
const MAX_REFERENCE_RESULTS = 100
const MAX_CODE_INTEL_OUTPUT_BYTES = 7000
const MAX_TRACKED_DIRECTORIES = 512
const MAX_UNCONFIGURED_DIRECTORIES = 2048
const RECENT_DIRECTORY_WINDOW_MS = 2000
const EXCLUDED_UNCONFIGURED_DIRECTORIES = new Set(['node_modules', '.meicode', '.mewcode'])
interface ServiceEntry {
  service: ts.LanguageService
  refreshFiles: () => void
  configFile?: string
  configStamps: Map<string, string>
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

function snapshotWildcardDirectories(parsed: ts.ParsedCommandLine | undefined, typescript: typeof ts): Map<string, string> | null {
  if (!parsed) return null
  const snapshot = new Map<string, string>()
  const visit = (dir: string, recursive: boolean): boolean => {
    if (snapshot.has(dir)) return true
    if (snapshot.size >= MAX_TRACKED_DIRECTORIES) return false
    const stamp = fileStamp(dir)
    snapshot.set(dir, stamp)
    if (!stamp || !recursive) return true
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !visit(join(dir, entry.name), true)) return false
    }
    return true
  }
  for (const [dir, flags] of Object.entries(parsed.wildcardDirectories ?? {})) {
    if (!visit(dir, (flags & typescript.WatchDirectoryFlags.Recursive) !== 0)) return null
  }
  return snapshot
}

function wildcardDirectoriesChanged(snapshot: Map<string, string> | null): boolean {
  if (!snapshot) return true
  for (const [dir, stamp] of snapshot) {
    if (fileStamp(dir) !== stamp) return true
  }
  return false
}

function unconfiguredDirectoryStamp(dir: string): { value: string; reusable: boolean } | null {
  try {
    const stats = statSync(dir, { bigint: true })
    const stableBefore = BigInt(Date.now() - RECENT_DIRECTORY_WINDOW_MS) * 1_000_000n
    return {
      value: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
      reusable: stats.mtimeNs < stableBefore && stats.ctimeNs < stableBefore,
    }
  } catch {
    return null
  }
}

function includeUnconfiguredPath(root: string, path: string): boolean {
  return !relative(root, path).split(/[\\/]/).some((segment) =>
    EXCLUDED_UNCONFIGURED_DIRECTORIES.has(process.platform === 'win32' ? segment.toLowerCase() : segment))
}

function snapshotUnconfiguredDirectories(root: string): Map<string, string> | null {
  const snapshot = new Map<string, string>()
  const visit = (dir: string): boolean => {
    if (snapshot.size >= MAX_UNCONFIGURED_DIRECTORIES) return false
    const stamp = unconfiguredDirectoryStamp(dir)
    if (!stamp) return false
    snapshot.set(dir, stamp.value)
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (!includeUnconfiguredPath(root, child)) continue
      if (entry.isSymbolicLink()) return false
      if (entry.isDirectory() && !visit(child)) return false
    }
    return true
  }
  return visit(root) ? snapshot : null
}

function unconfiguredDirectoriesChanged(snapshot: Map<string, string> | null): boolean {
  if (!snapshot) return true
  for (const [dir, value] of snapshot) {
    const current = unconfiguredDirectoryStamp(dir)
    if (!current?.reusable || current.value !== value) return true
  }
  return false
}

function scanUnconfiguredFiles(cwd: string, typescript: typeof ts): string[] {
  return typescript.sys.readDirectory(cwd, ['.ts', '.tsx', '.js', '.jsx'])
    .filter((path) => includeUnconfiguredPath(cwd, path))
}

function createService(cwd: string, typescript: typeof ts): Pick<ServiceEntry, 'service' | 'refreshFiles' | 'configStamps'> {
  const files = new Map<string, CachedScript>()
  const tsconfig = typescript.findConfigFile(cwd, typescript.sys.fileExists)
  const extendedConfigCache = new Map<string, ts.ExtendedConfigCacheEntry>()
  const parsedConfig = tsconfig ? typescript.getParsedCommandLineOfConfigFile(tsconfig, {}, typescript.sys as never, extendedConfigCache) : undefined
  const configStamps = new Map<string, string>()
  if (tsconfig) configStamps.set(tsconfig, fileStamp(tsconfig))
  for (const file of extendedConfigCache.keys()) configStamps.set(file, fileStamp(file))
  const options: ts.CompilerOptions = parsedConfig?.options ?? {}
  let scriptFileNames = parsedConfig?.fileNames ?? []
  let directorySnapshot = snapshotWildcardDirectories(parsedConfig, typescript)
  let unconfiguredSnapshot: Map<string, string> | null = null
  let unconfiguredLoaded = false
  const refreshFiles = () => {
    if (!tsconfig) {
      if (!unconfiguredLoaded || unconfiguredDirectoriesChanged(unconfiguredSnapshot)) {
        scriptFileNames = scanUnconfiguredFiles(cwd, typescript)
        unconfiguredSnapshot = snapshotUnconfiguredDirectories(cwd)
        unconfiguredLoaded = true
      }
      return
    }
    if (!wildcardDirectoriesChanged(directorySnapshot)) return
    const updated = typescript.getParsedCommandLineOfConfigFile(tsconfig, {}, typescript.sys as never)
    scriptFileNames = updated?.fileNames ?? []
    directorySnapshot = snapshotWildcardDirectories(updated, typescript)
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
      if (!tsconfig && !unconfiguredLoaded) refreshFiles()
      return [...scriptFileNames]
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
  return { service: typescript.createLanguageService(host, typescript.createDocumentRegistry()), refreshFiles, configStamps }
}

function getService(cwd: string, typescript: typeof ts): ts.LanguageService {
  const absolute = resolve(cwd)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const configFile = typescript.findConfigFile(absolute, typescript.sys.fileExists)
  const cached = serviceCache.get(key)
  if (cached && cached.configFile === configFile
    && [...cached.configStamps].every(([file, stamp]) => fileStamp(file) === stamp)) {
    cached.refreshFiles()
    serviceCache.delete(key)
    serviceCache.set(key, cached)
    return cached.service
  }
  cached?.service.dispose()
  const created = createService(absolute, typescript)
  serviceCache.set(key, { ...created, configFile })
  if (serviceCache.size > MAX_SERVICE_CACHE) {
    const oldest = serviceCache.entries().next().value as [string, { service: ts.LanguageService }] | undefined
    if (oldest) {
      serviceCache.delete(oldest[0])
      oldest[1].service.dispose()
    }
  }
  return created.service
}

function findIdentifierPosition(source: ts.SourceFile, name: string, typescript: typeof ts): number | undefined {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if ((typescript.isIdentifier(node) || typescript.isPrivateIdentifier(node)) && node.text === name) return node
    return typescript.forEachChild(node, visit)
  }
  const match = visit(source)
  return match === undefined ? undefined : match.getStart(source) + Math.floor(match.getWidth(source) / 2)
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
    if (ctx.signal?.aborted) return { success: false, output: '', error: '代码智能已取消' }
    const action = String(args.action ?? '')
    const file = args.file ? resolve(ctx.cwd, String(args.file)) : undefined
    const sym = typeof args.sym === 'string' ? args.sym : ''
    const line = typeof args.line === 'number' ? args.line : 0

    if (file && !existsSync(file)) return { success: false, output: '', error: `文件不存在: ${file}` }

    try {
      const loaded = await resolveOnAbort(() => import('typescript5'), ctx.signal, null)
      if (!loaded || ctx.signal?.aborted) return { success: false, output: '', error: '代码智能已取消' }
      const { default: typescript } = loaded
      const svc = getService(ctx.cwd, typescript)

      if (action === 'diagnostics') {
        if (!file) return { success: false, output: '', error: 'diagnostics 需要 file' }
        const synt = svc.getSyntacticDiagnostics(file)
        const sem = svc.getSemanticDiagnostics(file)
        const all = [...synt, ...sem]
        if (all.length === 0) return { success: true, output: '✅ 无诊断错误' }
        const header = `${all.length} 个诊断:`
        const lines: string[] = []
        let outputBytes = Buffer.byteLength(header, 'utf8') + 1
        for (const d of all) {
          if (lines.length >= MAX_DIAGNOSTIC_RESULTS) break
          const pos = d.start ?? 0
          const lc = d.file?.getLineAndCharacterOfPosition(pos)
          const msg = typescript.flattenDiagnosticMessageText(d.messageText, '\n')
          const entry = `${relative(ctx.cwd, d.file?.fileName ?? file).replaceAll('\\', '/')}:${(lc?.line ?? 0) + 1}:${(lc?.character ?? 0) + 1} [${d.category === 1 ? 'error' : 'warning'}] ${msg.slice(0, 150)}`
          const entryBytes = Buffer.byteLength(entry, 'utf8') + 1
          if (outputBytes + entryBytes > MAX_CODE_INTEL_OUTPUT_BYTES) break
          lines.push(entry)
          outputBytes += entryBytes
        }
        const omitted = all.length - lines.length
        return {
          success: true,
          output: `${header}\n${lines.join('\n') || '(无可显示项)'}${omitted > 0 ? `\n…[省略 ${omitted} 条诊断]` : ''}`,
          truncated: omitted > 0,
        }
      }

      if (action === 'defs' || action === 'refs') {
        if (!file) return { success: false, output: '', error: `${action} 需要 file` }
        const text = readFileSync(file, 'utf8')
        let pos = 0
        if (line > 0) {
          if (!Number.isInteger(line)) return { success: false, output: '', error: 'line 必须是正整数' }
          let lineStart = 0
          for (let current = 1; current < line; current++) {
            const newline = text.indexOf('\n', lineStart)
            if (newline < 0) return { success: false, output: '', error: `行号超出范围: ${line}` }
            lineStart = newline + 1
          }
          const newline = text.indexOf('\n', lineStart)
          const target = text.slice(lineStart, newline < 0 ? text.length : newline)
          const scanner = typescript.createScanner(typescript.ScriptTarget.Latest, true, typescript.LanguageVariant.Standard, target)
          let token = scanner.scan()
          while (token !== typescript.SyntaxKind.EndOfFileToken) {
            if ((token === typescript.SyntaxKind.Identifier || token === typescript.SyntaxKind.PrivateIdentifier)
              && (!sym || scanner.getTokenValue() === sym)) {
              pos = lineStart + scanner.getTokenPos() + Math.floor(scanner.getTokenText().length / 2)
              break
            }
            token = scanner.scan()
          }
          if (token === typescript.SyntaxKind.EndOfFileToken) {
            return { success: false, output: '', error: sym ? `符号 ${sym} 未在第 ${line} 行找到` : `第 ${line} 行没有可定位的符号` }
          }
        } else if (sym) {
          const source = svc.getProgram()?.getSourceFile(file)
            ?? typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true)
          const found = findIdentifierPosition(source, sym, typescript)
          if (found === undefined) return { success: false, output: '', error: `符号 ${sym} 未在文件中找到` }
          pos = found
        } else {
          return { success: false, output: '', error: '需要 sym 或 line' }
        }

        const loc = svc.getDefinitionAtPosition(file, pos)
        if (!loc || loc.length === 0) return { success: false, output: '', error: '未找到定义(符号可能是内置/外部)' }
        if (action === 'defs') {
          const program = svc.getProgram()
          const header = `定义(${loc.length} 处):`
          const sources = new Map<string, ts.SourceFile>()
          const lines: string[] = []
          let outputBytes = Buffer.byteLength(header, 'utf8') + 1
          for (const definition of loc) {
            if (lines.length >= MAX_DEFINITION_RESULTS) break
            const src = sources.get(definition.fileName)
              ?? program?.getSourceFile(definition.fileName)
              ?? typescript.createSourceFile(definition.fileName, existsSync(definition.fileName) ? readFileSync(definition.fileName, 'utf8') : '', typescript.ScriptTarget.Latest, false)
            sources.set(definition.fileName, src)
            const location = src.getLineAndCharacterOfPosition(definition.textSpan.start)
            const entry = `${relative(ctx.cwd, definition.fileName).replaceAll('\\', '/')}:${location.line + 1}:${location.character + 1}`
            const entryBytes = Buffer.byteLength(entry, 'utf8') + 1
            if (outputBytes + entryBytes > MAX_CODE_INTEL_OUTPUT_BYTES) break
            lines.push(entry)
            outputBytes += entryBytes
          }
          const omitted = loc.length - lines.length
          return {
            success: true,
            output: `${header}\n${lines.join('\n') || '(无可显示项)'}${omitted > 0 ? `\n…[省略 ${omitted} 处]` : ''}`,
            truncated: omitted > 0,
          }
        }
        const refs = svc.findReferences(file, pos) ?? []
        const total = refs.reduce((count, group) => count + group.references.length, 0)
        const header = `引用(${total} 处，${refs.length} 组):`
        const program = svc.getProgram()
        const sources = new Map<string, ts.SourceFile>()
        const lines: string[] = []
        let outputBytes = Buffer.byteLength(header, 'utf8') + 1
        referenceLoop: for (const group of refs) {
          for (const ref of group.references) {
            if (lines.length >= MAX_REFERENCE_RESULTS) break referenceLoop
            const source = sources.get(ref.fileName)
              ?? program?.getSourceFile(ref.fileName)
              ?? typescript.createSourceFile(ref.fileName, readFileSync(ref.fileName, 'utf8'), typescript.ScriptTarget.Latest, false)
            sources.set(ref.fileName, source)
            const location = source.getLineAndCharacterOfPosition(ref.textSpan.start)
            const entry = `${relative(ctx.cwd, ref.fileName).replaceAll('\\', '/')}:${location.line + 1}:${location.character + 1}${ref.isDefinition ? ' [定义]' : ''}`
            const entryBytes = Buffer.byteLength(entry, 'utf8') + 1
            if (outputBytes + entryBytes > MAX_CODE_INTEL_OUTPUT_BYTES) break referenceLoop
            lines.push(entry)
            outputBytes += entryBytes
          }
        }
        const omitted = total - lines.length
        const body = lines.join('\n') || (total === 0 ? '(无)' : '(无可显示项)')
        return {
          success: true,
          output: `${header}\n${body}${omitted > 0 ? `\n…[省略 ${omitted} 处]` : ''}`,
          truncated: omitted > 0,
        }
      }

      return { success: false, output: '', error: `未知 action: ${action}(defs/refs/diagnostics)` }
    } catch (e) {
      return { success: false, output: '', error: `代码智能失败: ${(e as Error).message.slice(0, 200)}` }
    }
  },
}
