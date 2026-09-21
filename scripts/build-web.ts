import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

// Static assets the shell needs offline.
for (const asset of ['manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']) {
  await copyFile(join(root, 'web', asset), join(dist, asset))
}

/**
 * The service worker is built separately: it runs in a worker scope, and its
 * precache list has to name the hashed bundle, which only exists once the app
 * has been built. The cache name embeds the hash too, so a deploy replaces the
 * old shell instead of serving it forever.
 */
const precache = ['./', 'index.html', bundleName, 'manifest.webmanifest', 'icon.svg']
const worker = await esbuild.build({
  entryPoints: [join(root, 'web/sw.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  write: false,
  logLevel: 'warning',
})
const workerSource = worker.outputFiles?.[0]
if (!workerSource) throw new Error('esbuild produced no service worker')
const workerCode = new TextDecoder()
  .decode(workerSource.contents)
  .replace('__PRECACHE__', JSON.stringify(precache).replace(/"/g, '\\"'))
  .replace('__CACHE_NAME__', `trip-companion-${hash}`)
if (workerCode.includes('__PRECACHE__') || workerCode.includes('__CACHE_NAME__')) {
  throw new Error('service worker placeholders were not substituted')
}
await writeFile(join(dist, 'sw.js'), workerCode, 'utf8')

// GitHub Pages runs Jekyll by default, which drops files beginning with an
// underscore and slows every deploy for no benefit here.
await writeFile(join(dist, '.nojekyll'), '', 'utf8')

console.log(`dist/ built — ${bundleName} ${(output.contents.byteLength / 1024).toFixed(1)} kB`)
