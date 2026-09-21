import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EntityCache } from './cache/entityCache.ts'
import { FileStore } from './cache/fileStore.ts'
import { DeterministicProvider } from './content/providers/deterministic.ts'
import { StaticGeocoder } from './geo/geocode.ts'
import { defaultDeps, runPipeline, type PipelineDeps } from './pipeline.ts'
import { NullTransitProvider } from './routing/transit.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o', default: 'out/briefing.html' },
    title: { type: 'string', short: 't' },
    departs: { type: 'string', short: 'd' },
    cache: { type: 'string', default: '.cache/entities.json' },
    contact: { type: 'string' },
    offline: { type: 'boolean', default: false },
    interactive: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help || positionals.length === 0) {
  console.log(`Usage: node src/cli.ts <itinerary.txt> [options]

  -o, --out <path>        output HTML (default out/briefing.html)
  -t, --title <text>      trip title
  -d, --departs <date>    departure date, YYYY-MM-DD
      --cache <path>      entity cache (default .cache/entities.json)
      --contact <email>   sent to Photon in the User-Agent, per its usage policy
      --offline           no network: no geocoding, no routing
      --interactive       include the flag and regenerate controls
`)
  process.exit(values.help ? 0 : 1)
}

const inputPath = resolve(String(positionals[0]))
const text = await readFile(inputPath, 'utf8')

const deps: PipelineDeps = values.offline
  ? {
      geocoder: new StaticGeocoder({}),
      routers: [new NullTransitProvider()],
      providers: [new DeterministicProvider()],
      cache: await EntityCache.open(new FileStore(String(values.cache))),
    }
  : await defaultDeps({
      ...(values.cache ? { cacheStore: new FileStore(String(values.cache)) } : {}),
      ...(values.contact ? { contact: values.contact } : {}),
    })

const result = await runPipeline(text, deps, {
  ...(values.title ? { title: values.title } : {}),
  ...(values.departs ? { departsOn: values.departs } : {}),
  render: { interactive: Boolean(values.interactive) },
})

await deps.cache?.flush()

const outPath = resolve(String(values.out))
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, result.html, 'utf8')

const { build, fill, content } = result.reports
console.log(`Wrote ${outPath}`)
console.log(`  places   ${build.resolved} resolved, ${build.unresolved.length} unresolved`)
if (build.needsConfirmation.length > 0) {
  console.log(`  confirm  ${build.needsConfirmation.length} ambiguous: ${build.needsConfirmation.map((c) => c.query).join(', ')}`)
}
console.log(`  legs     ${fill.routed} routed, ${fill.walkFallback} walk-fallback, ${fill.inferred} inferred`)
console.log(`  cards    ${content.generated} generated, ${content.fromCache} from cache`)
if (content.refusals.length > 0) {
  console.log(`  refused  ${content.refusals.length} operational cards could not be substantiated`)
}
if (content.voiceRejections.length > 0) {
  console.log(`  voice    ${content.voiceRejections.length} rejected: ${content.voiceRejections.map((v) => v.rules.join('/')).join(', ')}`)
}
for (const note of fill.notes.slice(0, 5)) console.log(`    - ${note}`)
