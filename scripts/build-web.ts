import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import { buildLabel } from '../src/build.ts'
import { BRIEFING_CSS } from '../src/render/styles.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
await mkdir(dist, { recursive: true })

/**
 * The anon key is designed to ship in a browser bundle; row-level security is
 * what protects the data, not the secrecy of this key. Both blank builds the
 * local-only app, which is a supported mode rather than a broken one.
 */
// PUBLIC_ prefix matches the convention in orchard-map and restroom-map.
const supabaseUrl = process.env['PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? ''
const supabaseAnonKey =
  process.env['PUBLIC_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? ''

/**
 * Which build this is, the same way orchard-map and restroom-map say it: the
 * commit count, shown as v43 and mapping back to exactly one commit.
 *
 *   git rev-list --reverse HEAD | sed -n '43p'
 *
 * It is worth more here than in either of those, because this app installs a
 * service worker. A hard refresh does not go round a worker — it still
 * controls the navigation and answers with what it precached — and Pages
 * serves the HTML itself with a ten-minute cache on top. Between them a deploy
 * can be finished, green, and invisible in an open tab. The number is what
 * somebody reads out when the site "has not changed".
 */
function buildId(): string {
  if (process.env['BUILD_ID']) return process.env['BUILD_ID']

  let count: string
  try {
    count = execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // No git at all — a tarball, say. Say so rather than inventing a number: a
    // wrong version is worse than an obviously missing one when the whole
    // point is reading it out when something looks wrong.
    return 'dev'
  }

  /*
   * A count of 1 from CI means a shallow clone, not a first commit.
   *
   * This is the failure the version number exists to survive, and it is
   * silent: actions/checkout clones with depth 1 by default, every build then
   * stamps v1, and the tag looks like a version while never changing — which
   * is worse than having none, because people trust it. pages.yml sets
   * fetch-depth: 0 for exactly this reason, and this is what notices when
   * somebody takes it out again.
   */
  if (process.env['CI'] && count === '1') {
    throw new Error(
      'git rev-list --count HEAD returned 1 in CI, which means a shallow ' +
        'clone. Set `fetch-depth: 0` on actions/checkout, or pass BUILD_ID ' +
        'explicitly if this really is the first commit.',
    )
  }

  return count || 'dev'
}

const build = buildId()

const built = await esbuild.build({
  entryPoints: [join(root, 'web/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  write: false,
  logLevel: 'warning',
  define: {
    __SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
    __BUILD_ID__: JSON.stringify(build),
  },
  // With no backend configured the client is never constructed, so the real
  // library is swapped for a stub rather than shipped as dead weight.
  ...(supabaseUrl
    ? {}
    : { alias: { '@supabase/supabase-js': join(root, 'web/supabase-stub.ts') } }),
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
  .replace('__CACHE_NAME__', `trip-companion-${build}-${hash}`)
if (workerCode.includes('__PRECACHE__') || workerCode.includes('__CACHE_NAME__')) {
  throw new Error('service worker placeholders were not substituted')
}
await writeFile(join(dist, 'sw.js'), workerCode, 'utf8')

// GitHub Pages runs Jekyll by default, which drops files beginning with an
// underscore and slows every deploy for no benefit here.
await writeFile(join(dist, '.nojekyll'), '', 'utf8')

console.log(
  `dist/ built \u2014 ${buildLabel(build)}, ${bundleName} ` +
    `${(output.contents.byteLength / 1024).toFixed(1)} kB, ` +
    `sw.js precaching ${precache.length} files, ` +
    `backend ${supabaseUrl ? 'configured' : 'not configured (local-only mode)'}`,
)
