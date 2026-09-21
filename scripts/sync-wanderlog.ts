import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { EntityCache } from '../src/cache/entityCache.ts'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import { OverpassProvider } from '../src/content/providers/overpass.ts'
import { WikipediaProvider } from '../src/content/providers/wikipedia.ts'
import { generateCards } from '../src/content/generate.ts'
import { tripFromWanderlog, wanderlogKey } from '../src/import/wanderlog.ts'
import { fillLegs } from '../src/routing/fill.ts'
import { OsrmProvider } from '../src/routing/osrm.ts'
import { NullTransitProvider } from '../src/routing/transit.ts'

const run = promisify(execFile)

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string', short: 'f' },
    title: { type: 'string', short: 't' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help || (positionals.length === 0 && !values.file)) {
  console.log(`Sync a Wanderlog trip into Trip Companion.

  node scripts/sync-wanderlog.ts <trip-key>     fetch via the wlog CLI
  node scripts/sync-wanderlog.ts -f trip.json   use a document you already have
  node scripts/sync-wanderlog.ts <key> --dry-run

Your Wanderlog session never leaves this machine. wlog reads it from its own
config; this script only ever sees the trip document wlog prints.

Environment:
  SUPABASE_URL             project url
  SUPABASE_ANON_KEY        anon key (safe to expose; RLS is the protection)
  SUPABASE_REFRESH_TOKEN   your session, from "Copy sync token" in the web app
  WANDERLOG_SESSION        optional, passed through to wlog if it is set
`)
  process.exit(values.help ? 0 : 2)
}

async function loadDocument(): Promise<unknown> {
  if (values.file) return JSON.parse(await readFile(values.file, 'utf8')) as unknown
  const key = String(positionals[0])
  try {
    // wlog reads its own stored session; we never handle the cookie.
    const { stdout } = await run('wlog', ['trip', 'get', key], {
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    })
    return JSON.parse(stdout) as unknown
  } catch (err) {
    const message = (err as { code?: string; message?: string }).code === 'ENOENT'
      ? 'wlog is not on PATH. Install it with: go install github.com/KRamdath/wanderlog-cli/cmd/wlog@latest'
      : `wlog trip get failed: ${(err as Error).message}`
    console.error(message)
    process.exit(1)
  }
}

const document = await loadDocument()
const { trip: bare, report } = tripFromWanderlog(document, {
  ...(values.title ? { title: values.title } : {}),
})

if (bare.places.length === 0) {
  console.error('No places with coordinates found in that trip document.')
  process.exit(1)
}

console.log(`${bare.title}: ${report.places} places across ${report.sections} sections`)
if (report.unscheduled > 0) {
  console.log(`  ${report.unscheduled} in standing lists rather than on a day`)
}
// Both of these want a human, so they are said out loud rather than counted.
for (const name of report.skipped) {
  console.log(`  SKIPPED ${name} — no coordinates in the document`)
}
for (const conflict of report.regionConflicts) {
  console.log(`  CHECK   ${conflict.name} — tagged ${conflict.region}, unlike the rest of the trip`)
}

// Wanderlog places already carry Google geometry, so there is no geocoding
// step here at all — and none of the ambiguity that comes with one.
const filled = await fillLegs(bare, [new OsrmProvider(), new NullTransitProvider()])
const cache = await EntityCache.open()
const generated = await generateCards(filled.trip, {
  providers: [new OverpassProvider(), new WikipediaProvider(), new DeterministicProvider()],
  cache,
})

console.log(
  `  legs   ${filled.report.routed} routed, ${filled.report.walkFallback} walk-fallback, ${filled.report.inferred} inferred`,
)
console.log(`  cards  ${generated.report.generated} generated`)
for (const problem of generated.report.sourceProblems) {
  console.log(`  SOURCE ${problem.provider} unreachable: ${problem.reason}`)
}

if (values['dry-run']) {
  console.log('\nDry run: nothing was uploaded.')
  process.exit(0)
}

const url = process.env['SUPABASE_URL']
const anonKey = process.env['SUPABASE_ANON_KEY']
const refreshToken = process.env['SUPABASE_REFRESH_TOKEN']
if (!url || !anonKey || !refreshToken) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_REFRESH_TOKEN to upload.')
  process.exit(1)
}

const db = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
const { data: session, error: authError } = await db.auth.refreshSession({ refresh_token: refreshToken })
if (authError || !session.user) {
  console.error(`Could not sign in: ${authError?.message ?? 'no session'}`)
  console.error('Refresh tokens rotate. Copy a fresh one from the web app.')
  process.exit(1)
}

const sourceKey = wanderlogKey(document) ?? String(positionals[0] ?? 'unknown')
const { error } = await db.from('trips').upsert(
  {
    owner: session.user.id,
    title: generated.trip.title,
    departs_on: generated.trip.departsOn ?? null,
    graph: generated.trip,
    source: 'wanderlog',
    source_key: sourceKey,
  },
  { onConflict: 'owner,source,source_key' },
)

if (error) {
  console.error(`Upload failed: ${error.message}`)
  process.exit(1)
}
console.log(`\nSynced as ${session.user.email} — trip key ${sourceKey}`)
