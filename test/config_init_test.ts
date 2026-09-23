import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeConfig } from '../src/config/init.ts'
import { parseArgs } from '../src/cli-fast.ts'
import { MEICODE_VERSION } from '../src/version.ts'

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
  const args = parseArgs(['--run', 'task', '--resume', 'session-1', '--yolo', '--config', target, '--acp-port', '8123', '--a2a-push-allow-url', 'https://example.com/hook', '--doctor'])
  if (args.run !== 'task' || args.resume !== 'session-1' || !args.yolo || args.config !== target || args.acpPort !== 8123 || !args.doctor) throw new Error('CLI 参数解析失败')
  if (args.a2aPushAllowedUrls[0] !== 'https://example.com/hook') throw new Error('A2A Push URL 参数解析失败')
  const packageVersion = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
  if (MEICODE_VERSION !== packageVersion) throw new Error(`运行时版本与 package.json 不一致: ${MEICODE_VERSION} !== ${packageVersion}`)
  console.log('config_init_test passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
