#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  const { readFileSync } = await import('node:fs')
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  console.log(packageJson.version)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('MeiCode - 终端多智能体 AI 助手')
  console.log('用法: meicode [--config <path>] [--run <task> [--resume <id>]] [--init|--doctor] [--yolo]')
  console.log('服务: --acp-port <port>  --a2a-port <port>')
  console.log('选项: --init  --doctor  --resume <id>  --yolo  --help  --version')
  process.exit(0)
}
if (args.includes('--init')) {
  const { main } = await import(new URL('../dist/cli-init.mjs', import.meta.url).href)
  main(args)
} else if (args.includes('--doctor')) {
  const { main } = await import(new URL('../dist/cli-fast.mjs', import.meta.url).href)
  main(args)
} else {
  await import(new URL('../dist/cli.mjs', import.meta.url).href)
}
