import { join } from 'node:path'
import { initializeConfig } from './config/init.ts'
import { userStatePath } from './state-paths.ts'

export function main(argv = process.argv.slice(2)): void {
  let config: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) config = argv[++i]
  }
  const target = config ?? userStatePath('config.yaml')
  const result = initializeConfig(join(import.meta.dirname, '..', 'config.example.yaml'), target)
  console.log(result.created ? `已创建配置文件: ${result.path}` : `配置文件已存在，未覆盖: ${result.path}`)
}
