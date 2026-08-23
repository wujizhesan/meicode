import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const temp = mkdtempSync(join(tmpdir(), 'meicode-package-'))
const npmrc = join(temp, 'npmrc')
writeFileSync(npmrc, 'ignore-scripts=true\n')
const cleanNpmEnv = { ...process.env, npm_config_userconfig: npmrc, npm_config_allow_scripts: '', npm_config_ignore_scripts: 'true' }
const npmExecPath = process.env.npm_execpath
const runNpm = (args, options = {}) => npmExecPath
  ? execFileSync(process.execPath, [npmExecPath, ...args], options)
  : execFileSync(npm, args, { shell: process.platform === 'win32', ...options })

try {
  runNpm(['run', 'build'], { cwd: root, stdio: 'inherit' })
  const output = runNpm(['pack', '--pack-destination', temp, '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: cleanNpmEnv })
  const packageInfo = JSON.parse(output)[0]
  const tarball = join(temp, packageInfo.filename)
  const installRoot = join(temp, 'install')
  mkdirSync(installRoot, { recursive: true })
  runNpm(['init', '-y'], { cwd: installRoot, stdio: 'ignore', env: cleanNpmEnv })
  const consumerPackage = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8'))
  consumerPackage.allowScripts = {}
  writeFileSync(join(installRoot, 'package.json'), JSON.stringify(consumerPackage, null, 2))
  runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: installRoot, stdio: 'inherit', env: cleanNpmEnv })
  const entry = join(installRoot, 'node_modules', 'meicode', 'bin', 'meicode.mjs')
  const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const version = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim()
  if (version !== expectedVersion) throw new Error(`版本检查失败: ${version} !== ${expectedVersion}`)
  execFileSync(process.execPath, [entry, '--help'], { stdio: 'ignore' })
  const initConfig = join(temp, 'init-config.yaml')
  execFileSync(process.execPath, [entry, '--init', '--config', initConfig], { stdio: 'inherit' })
  if (!existsSync(initConfig)) throw new Error('发行包配置初始化失败')
  execFileSync(process.execPath, [entry, '--doctor', '--config', initConfig], { stdio: 'inherit' })
  console.log(`Package smoke passed: meicode@${version}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
