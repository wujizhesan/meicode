import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const sourceMap = process.env.MEICODE_SOURCEMAP === 'true'

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: sourceMap,
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  charset: 'utf8',
}

const runtimeExternals = [
  'ink',
  'react',
  'react/*',
  'playwright-core',
  'typescript5',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  'pngjs',
  'pixelmatch',
  'minimatch',
]

await Promise.all([
  build({
    ...common,
    entryPoints: { cli: join(root, 'src', 'cli.tsx') },
    outdir: dist,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    splitting: true,
    external: runtimeExternals,
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src', 'cli-fast.ts')],
    outfile: join(dist, 'cli-fast.mjs'),
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src', 'cli-init.ts')],
    outfile: join(dist, 'cli-init.mjs'),
  }),
])

cpSync(join(root, 'src', 'agents'), join(dist, 'agents'), { recursive: true })
cpSync(join(root, 'src', 'skills'), join(dist, 'skills'), { recursive: true })
console.log(`MeiCode build complete: ${dist}`)
