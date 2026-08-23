import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'cli.tsx')],
  outfile: join(dist, 'cli.mjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
})

cpSync(join(root, 'src', 'agents'), join(dist, 'agents'), { recursive: true })
cpSync(join(root, 'src', 'skills'), join(dist, 'skills'), { recursive: true })
console.log(`MeiCode build complete: ${dist}`)
