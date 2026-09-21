import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import { BRIEFING_CSS } from '../src/render/styles.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
await mkdir(dist, { recursive: true })

const built = await esbuild.build({
  entryPoints: [join(root, 'web/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  write: false,
  logLevel: 'warning',
})

const output = built.outputFiles?.[0]
if (!output) throw new Error('esbuild produced no bundle')

/**
 * The filename is hashed from the emitted bytes, not by esbuild's own [hash]
 * placeholder — that placeholder did not change when the bundle's contents
 * did, which is worse than no hashing at all because it fails silently.
 *
 * This matters because Pages serves with max-age=600: without a name that
 * tracks content, a deploy leaves browsers on the previous bundle for ten
 * minutes and can pair new HTML with old JS.
 */
const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, 10)
const bundleName = `app.${hash}.js`

for (const stale of await readdir(dist)) {
  if (/^app\.[0-9a-f]+\.js$/.test(stale) && stale !== bundleName) await rm(join(dist, stale))
}

await writeFile(join(dist, bundleName), output.contents)

const template = await readFile(join(root, 'web/index.html'), 'utf8')
const page = template.replace('/*__CSS__*/', BRIEFING_CSS).replace('src="app.js"', `src="${bundleName}"`)
if (!page.includes(bundleName)) throw new Error('index.html does not reference the bundle')
await writeFile(join(dist, 'index.html'), page, 'utf8')

// GitHub Pages runs Jekyll by default, which drops files beginning with an
// underscore and slows every deploy for no benefit here.
await writeFile(join(dist, '.nojekyll'), '', 'utf8')

console.log(`dist/ built — ${bundleName} ${(output.contents.byteLength / 1024).toFixed(1)} kB`)
