import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import { BRIEFING_CSS } from '../src/render/styles.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
await mkdir(dist, { recursive: true })

const result = await esbuild.build({
  entryPoints: [join(root, 'web/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  outfile: join(dist, 'app.js'),
  metafile: true,
  logLevel: 'warning',
})

const template = await readFile(join(root, 'web/index.html'), 'utf8')
await writeFile(join(dist, 'index.html'), template.replace('/*__CSS__*/', BRIEFING_CSS), 'utf8')

// GitHub Pages runs Jekyll by default, which drops files beginning with an
// underscore and slows every deploy for no benefit here.
await writeFile(join(dist, '.nojekyll'), '', 'utf8')

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
console.log(`dist/ built — app.js ${(bytes / 1024).toFixed(1)} kB`)
