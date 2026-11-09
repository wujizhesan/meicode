const SHELL_OPERATOR_RE = /[&;<>\r\n]/
const GIT_WRITE_OPTION_RE = /^(?:--output(?:=.*)?|-o(?:=.*)?|--ext-diff)$/i
const SHELL_EXECUTABLES = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash'])

// 命令包装前缀：这些可执行文件把"真正要执行的命令"放在后面的位置参数里。
// 黑名单/警告表正则锚定行首(`^\s*`)，不剥离前缀则 `sudo rm -rf /`、
// `env FOO=1 rm -rf /`、`eval "rm -rf /"` 等可直接绕过硬拦截。
const PRIVILEGE_PREFIXES = new Set(['sudo', 'sudoedit', 'doas', 'runas', 'pkexec', 'su'])
const ESCALATION_PREFIXES = new Set(['eval'])
const BENIGN_PREFIXES = new Set([
  'env',
  'nohup',
  'nice',
  'ionice',
  'setsid',
  'stdbuf',
  'timeout',
  'time',
  'command',
  'builtin',
  'exec',
  'xargs',
])

// 包装器自身的带值选项：会吃掉紧随其后的 token，必须跳过，
// 否则取值(如 `sudo -u root` 里的 root)会被误当成待执行命令。
const PREFIX_VALUE_OPTIONS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-D', '--user', '--group', '--prompt', '--chdir', '--host', '--role', '--type', '--other-user', '--close-from'],
  doas: ['-u', '-C'],
  pkexec: ['--user', '--disable-internal-agent'],
  runas: ['/user', '/trustlevel', '/showtrustlevels'],
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '--class', '--classdata', '--pid'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  timeout: ['-k', '--kill-after', '-s', '--signal'],
  xargs: ['-a', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars'],
}

const SIMPLE_READ_ONLY = new Set([
  'cat',
  'dir',
  'du',
  'file',
  'findstr',
  'grep',
  'head',
  'ls',
  'more',
  'od',
  'stat',
  'strings',
  'tail',
  'type',
  'wc',
  'where',
  'xxd',
])

function isReadOnlyGit(tokens: string[]): boolean {
  const subcommand = tokens[1]?.toLowerCase()
  if (!subcommand) return false
  if (tokens.slice(2).some((token) => GIT_WRITE_OPTION_RE.test(token))) return false
  if (['diff', 'log', 'ls-files', 'rev-parse', 'show', 'status'].includes(subcommand)) return true
  if (subcommand === 'stash') return tokens[2]?.toLowerCase() === 'list'
  if (subcommand === 'remote') {
    const operation = tokens[2]?.toLowerCase()
    return operation === undefined || operation === '-v' || operation === 'get-url'
  }
  return false
}

export function hasGitWriteOption(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  return tokens[0]?.toLowerCase() === 'git'
    && ['diff', 'log', 'show'].includes(tokens[1]?.toLowerCase() ?? '')
    && tokens.slice(2).some((token) => GIT_WRITE_OPTION_RE.test(token))
}

export function commandRuleValue(args: Record<string, unknown>): string | null {
  if (typeof args.command !== 'string') return null
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  return argv.length > 0
    ? `argv:${JSON.stringify([args.command, ...argv])}`
    : args.command.replace(/\s+/g, ' ').trim()
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote = ''
  for (const char of command) {
    if (char === '"' || (process.platform !== 'win32' && char === "'")) {
      quote = quote === char ? '' : quote || char
      current += char
    } else if (!quote && /[&|;\r\n]/.test(char)) {
      if (current.trim()) segments.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function shellExecutable(command: string): boolean {
  const first = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean)
  const basename = first?.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, '')
  return SHELL_EXECUTABLES.has(basename ?? '')
}

// 引号感知分词：与 splitShellSegments 保持一致的引号语义
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote = ''
  for (const char of input) {
    if (char === '"' || (process.platform !== 'win32' && char === "'")) {
      quote = quote === char ? '' : quote || char
      current += char
    } else if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) tokens.push(current)
  return tokens
}

function commandName(token: string): string {
  const unquoted = token.replace(/^["']|["']$/g, '')
  return (unquoted.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')
}

function optionTakesValue(token: string, options: readonly string[]): boolean {
  for (const option of options) {
    if (option.startsWith('--')) {
      if (token === option || token.startsWith(`${option}=`)) return true
    } else if (token === option || token.startsWith(option)) {
      return true
    }
  }
  return false
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

interface PrefixStrip {
  remainder: string
  escalate: boolean
}

// 剥离一层命令包装前缀，返回真正要执行的命令文本；不是包装前缀时返回 null。
// escalate 表示该前缀能提权或执行任意字符串（sudo/eval 等），需要额外确认。
function stripCommandPrefix(input: string): PrefixStrip | null {
  const tokens = tokenize(input.trim())
  if (tokens.length < 2) return null
  const head = commandName(tokens[0])
  const escalate = PRIVILEGE_PREFIXES.has(head) || ESCALATION_PREFIXES.has(head)
  if (!escalate && !BENIGN_PREFIXES.has(head)) return null
  const valueOptions = PREFIX_VALUE_OPTIONS[head] ?? []
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { // env FOO=1
      index++
      continue
    }
    if (token.startsWith('-')) {
      const takesValue = optionTakesValue(token, valueOptions)
      index++
      if (takesValue && !token.includes('=')) index++
      continue
    }
    if (token.startsWith('/')) { // runas /user:Administrator
      const takesValue = optionTakesValue(token.split(':')[0], valueOptions)
      index++
      if (takesValue && !token.includes(':')) index++
      continue
    }
    break
  }
  // timeout 5 rm ... / nice 10 rm ...：数值时长是位置参数而非选项
  if (index < tokens.length && (head === 'timeout' || head === 'time' || head === 'nice') && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index])) index++
  if (index >= tokens.length) return null
  const remainder = tokens.slice(index).join(' ')
  if (!remainder || remainder === input.trim()) return null
  return { remainder, escalate }
}

export function commandPolicyParts(args: Record<string, unknown>): { parts: string[]; shellWrapper: boolean; prefixWrapper: boolean } {
  const command = String(args.command ?? '')
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  const full = argv.length > 0 ? `${command} ${argv.join(' ')}` : command
  const parts: string[] = []
  const seen = new Set<string>()
  let shellWrapper = false
  let prefixWrapper = false
  const enqueue = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed) || parts.length >= 64) return
    seen.add(trimmed)
    parts.push(trimmed)
  }
  for (const seed of argv.length > 0 && !shellExecutable(command) ? [full] : splitShellSegments(full)) enqueue(seed)
  // 逐个片段解开包装；新解出的片段会继续参与循环，因此多跳包装
  // (runas -> cmd /c -> format) 也能一路剥到底。
  for (let index = 0; index < parts.length && index < 64; index++) {
    const part = parts[index]
    // Shell 包装解包：cmd /c、powershell -Command、bash -c ...
    if (shellExecutable(part)) {
      shellWrapper = true
      const payload = part.replace(/^(?:"[^"]+"|'[^']+'|\S+)\s+(?:(?:\/d|\/s)\s+)*(?:\/c|\/k|-c|-command|--command)\s+/i, '')
      if (payload !== part) for (const segment of splitShellSegments(unquote(payload))) enqueue(segment)
    }
    // 命令包装前缀剥离：sudo/env/xargs/eval ...（黑名单/警告表锚定行首，不剥离即可绕过）
    const strip = stripCommandPrefix(part)
    if (!strip) continue
    if (strip.escalate) prefixWrapper = true
    for (const segment of splitShellSegments(unquote(strip.remainder))) enqueue(segment)
  }
  return { parts, shellWrapper, prefixWrapper }
}

function isReadOnlyPart(part: string): boolean {
  const tokens = part.trim().split(/\s+/).filter(Boolean)
  const executable = tokens[0]?.toLowerCase()
  if (!executable) return false
  if (SIMPLE_READ_ONLY.has(executable)) return true
  if (executable === 'git') return isReadOnlyGit(tokens)
  if (executable === 'node') return tokens.length === 2 && ['-v', '--version'].includes(tokens[1].toLowerCase())
  if (executable === 'npm') return ['list', 'ls', 'view'].includes(tokens[1]?.toLowerCase() ?? '')
  return false
}

export function isReadOnlyCommand(command: string, options: { allowPipelines?: boolean } = {}): boolean {
  if (SHELL_OPERATOR_RE.test(command) || /\|\|/.test(command)) return false
  if (!options.allowPipelines && command.includes('|')) return false
  return command.split('|').every(isReadOnlyPart)
}
