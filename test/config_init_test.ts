import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeConfig } from '../src/config/init.ts'
import { parseArgs } from '../src/cli-fast.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-config-init-'))
try {
  const example = join(root, 'config.example.yaml')
  const target = join(root, 'nested', 'config.yaml')
  writeFileSync(example, 'provider: deepseek\n')
  const created = initializeConfig(example, target)
  if (!created.created || !existsSync(target) || readFileSync(target, 'utf8') !== 'provider: deepseek\n') throw new Error('配置初始化失败')
  writeFileSync(target, 'provider: custom\n')
  const preserved = initializeConfig(example, target)
  if (preserved.created || readFileSync(target, 'utf8') !== 'provider: custom\n') throw new Error('已有配置被覆盖')
  const args = parseArgs(['--run', 'task', '--config', target, '--acp-port', '8123', '--doctor'])
  if (args.run !== 'task' || args.config !== target || args.acpPort !== 8123 || !args.doctor) throw new Error('CLI 参数解析失败')
  console.log('config_init_test passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
