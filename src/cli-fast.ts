import { homedir } from 'node:os'
import { join } from 'node:path'
import { initializeConfig } from './config/init.ts'
import { loadConfigWithMcp } from './config/loader.ts'

export interface CliArgs {
  config?: string
  run?: string
  init?: boolean
  doctor?: boolean
  acpPort?: number
  acpHost?: string
  acpToken?: string
  a2aPort?: number
  a2aToken?: string
}

export function parseArgs(argv: string[]): CliArgs {
  let config: string | undefined
  let run: string | undefined
  let init = false
  let doctor = false
  let acpPort: number | undefined
  let acpHost: string | undefined
  let acpToken: string | undefined
  let a2aPort: number | undefined
  let a2aToken: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      config = argv[++i]
    } else if (argv[i] === '--run' && argv[i + 1]) {
      run = argv[++i]
    } else if (argv[i] === '--init') {
      init = true
    } else if (argv[i] === '--doctor') {
      doctor = true
    } else if (argv[i] === '--acp-port' && argv[i + 1]) {
      acpPort = Number(argv[++i])
    } else if (argv[i] === '--acp-host' && argv[i + 1]) {
      acpHost = argv[++i]
    } else if (argv[i] === '--acp-token' && argv[i + 1]) {
      acpToken = argv[++i]
    } else if (argv[i] === '--a2a-port' && argv[i + 1]) {
      a2aPort = Number(argv[++i])
    } else if (argv[i] === '--a2a-token' && argv[i + 1]) {
      a2aToken = argv[++i]
    }
  }
  return { config, run, init, doctor, acpPort, acpHost, acpToken, a2aPort, a2aToken }
}

export function runFastCommand(args: CliArgs): boolean {
  if (args.init) {
    const target = args.config ?? join(homedir(), '.mewcode', 'config.yaml')
    const result = initializeConfig(join(import.meta.dirname, '..', 'config.example.yaml'), target)
    console.log(result.created ? `已创建配置文件: ${result.path}` : `配置文件已存在，未覆盖: ${result.path}`)
    return true
  }
  if (args.doctor) {
    try {
      const loaded = loadConfigWithMcp(args.config)
      console.log(`配置有效: provider=${loaded.provider.name} protocol=${loaded.provider.protocol} model=${loaded.provider.model} mcp=${loaded.mcpServers.length} a2a=${loaded.a2aAgents.length}`)
    } catch (error) {
      console.error(`配置无效: ${(error as Error).message}`)
      process.exitCode = 1
    }
    return true
  }
  return false
}

export function main(argv = process.argv.slice(2)): void {
  if (!runFastCommand(parseArgs(argv))) throw new Error('快速入口仅支持 --init 或 --doctor')
}
