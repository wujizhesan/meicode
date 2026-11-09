import { join } from 'node:path'
import { initializeConfig } from './config/init.ts'
import { loadConfigWithMcp } from './config/loader.ts'
import { userStatePath } from './state-paths.ts'

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
  a2aPushAllowedUrls: string[]
  resume?: string
  yolo?: boolean
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
  const a2aPushAllowedUrls: string[] = []
  let resume: string | undefined
  let yolo = false
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
    } else if (argv[i] === '--a2a-push-allow-url' && argv[i + 1]) {
      a2aPushAllowedUrls.push(argv[++i])
    } else if (argv[i] === '--resume' && argv[i + 1]) {
      resume = argv[++i]
    } else if (argv[i] === '--yolo') {
      yolo = true
    }
  }
  return { config, run, init, doctor, acpPort, acpHost, acpToken, a2aPort, a2aToken, a2aPushAllowedUrls, resume, yolo }
}

export function runFastCommand(args: CliArgs): boolean {
  if (args.init) {
    const target = args.config ?? userStatePath('config.yaml')
    const result = initializeConfig(join(import.meta.dirname, '..', 'config.example.yaml'), target)
    console.log(result.created ? `已创建配置文件: ${result.path}` : `配置文件已存在，未覆盖: ${result.path}`)
    return true
  }
  if (args.doctor) {
    try {
      const loaded = loadConfigWithMcp(args.config)
      const [major, minor] = process.versions.node.split('.').map(Number)
      if (major < 20 || (major === 20 && minor < 11)) throw new Error(`Node.js 版本过低: ${process.versions.node}，需要 >=20.11`)
      const endpoint = new URL(loaded.provider.base_url)
      if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error(`base_url 协议不受支持: ${endpoint.protocol}`)
      const placeholderKey = /(?:xxxx|your[_-]?key|changeme|sk-(?:ant-)?test)/i.test(loaded.provider.api_key)
      console.log(`静态检查通过: node=${process.versions.node} provider=${loaded.provider.name} protocol=${loaded.provider.protocol} model=${loaded.provider.model}`)
      console.log(`模型预算: context=${loaded.provider.context_window ?? 131072} output=${loaded.provider.max_output_tokens ?? 16384}`)
      console.log(`连接配置: mcp=${loaded.mcpServers.length} a2a=${loaded.a2aAgents.length}`)
      for (const skipped of loaded.mcpSkipped) console.warn(`[Doctor] MCP 配置跳过: ${skipped}`)
      for (const skipped of loaded.a2aSkipped) console.warn(`[Doctor] A2A 配置跳过: ${skipped}`)
      if (placeholderKey) console.warn('[Doctor] API key 看起来仍是示例值；未执行联网验证')
      else console.log('联网状态: 未检查（Doctor 默认不发送外部请求）')
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
