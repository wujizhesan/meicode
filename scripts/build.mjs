import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const common = {
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
}

await Promise.all([
  build({
    ...common,
    entryPoints: { cli: join(root, 'src', 'cli.tsx') },
    outdir: dist,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    splitting: true,
    banner: { js: '#!/usr/bin/env node' },
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src', 'cli-fast.ts')],
    outfile: join(dist, 'cli-fast.mjs'),
  }),
])

cpSync(join(root, 'src', 'agents'), join(dist, 'agents'), { recursive: true })
cpSync(join(root, 'src', 'skills'), join(dist, 'skills'), { recursive: true })
console.log(`MeiCode build complete: ${dist}`)
