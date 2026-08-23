#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const root = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'))
const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  console.log(packageJson.version)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('MeiCode - 终端多智能体 AI 助手')
  console.log('用法: meicode [--config <path>] [--run <task>] [--init|--doctor]')
  console.log('服务: --acp-port <port>  --a2a-port <port>')
  console.log('选项: --init  --doctor  --help  --version')
  process.exit(0)
}
await import(pathToFileURL(join(root, '..', 'dist', 'cli.mjs')).href)
