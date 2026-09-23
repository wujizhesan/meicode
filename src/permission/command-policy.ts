const SHELL_OPERATOR_RE = /[&;<>\r\n]/
const GIT_WRITE_OPTION_RE = /^(?:--output(?:=.*)?|-o(?:=.*)?|--ext-diff)$/i
const SHELL_EXECUTABLES = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash'])

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

export function commandPolicyParts(args: Record<string, unknown>): { parts: string[]; shellWrapper: boolean } {
  const command = String(args.command ?? '')
  const argv = Array.isArray(args.args) ? args.args.map(String) : []
  const full = argv.length > 0 ? `${command} ${argv.join(' ')}` : command
  const parts = argv.length > 0 && !shellExecutable(command) ? [full] : splitShellSegments(full)
  let shellWrapper = false
  for (let index = 0; index < parts.length && index < 32; index++) {
    const part = parts[index]
    if (!shellExecutable(part)) continue
    shellWrapper = true
    const payload = part.replace(/^(?:"[^"]+"|'[^']+'|\S+)\s+(?:(?:\/d|\/s)\s+)*(?:\/c|\/k|-c|-command|--command)\s+/i, '')
    if (payload !== part) parts.push(...splitShellSegments(payload.replace(/^["']|["']$/g, '')))
  }
  return { parts, shellWrapper }
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
