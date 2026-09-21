import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { EntityCache } from '../src/cache/entityCache.ts'
import { FileStore } from '../src/cache/fileStore.ts'
import { acceptCorrection, rejectCorrection } from '../src/corrections/loop.ts'
import { FileCorrections } from '../src/corrections/fileStore.ts'
import { CorrectionStore, type Correction, type CorrectionSnapshot } from '../src/corrections/store.ts'

const { values } = parseArgs({
  options: {
    store: { type: 'string', default: '.cache/corrections.json' },
    cache: { type: 'string', default: '.cache/entities.json' },
    list: { type: 'boolean', default: false },
    import: { type: 'string' },
    accept: { type: 'string' },
    reject: { type: 'string' },
    body: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  console.log(`Review traveller reports and fold the accepted ones back in.

  --list                    show open reports
  --import <file.json>      merge reports exported from the web app
  --accept <id> --body "…"  accept, and write the corrected text to the entity store
  --reject <id>             reject
  --store <path>            reports file (default .cache/corrections.json)
  --cache <path>            entity cache (default .cache/entities.json)

Accepting writes into the entity store, keyed to the place rather than the
trip, so every later briefing through there inherits the fix.
`)
  process.exit(0)
}

const store = await CorrectionStore.open(new FileCorrections(String(values.store)))
const cache = await EntityCache.open(new FileStore(String(values.cache)))

function show(c: Correction): void {
  console.log(`\n  ${c.id}`)
  console.log(`  entity : ${c.entityKey}`)
  console.log(`  card   : ${c.cardKind}  (${c.status})`)
  console.log(`  showed : ${c.sawBody}`)
  console.log(`  report : ${c.claim}`)
  console.log(`  when   : ${c.submittedAt}`)
}

if (values.import) {
  const raw = await readFile(values.import, 'utf8')
  const parsed = JSON.parse(raw) as Correction[] | CorrectionSnapshot
  const incoming = Array.isArray(parsed) ? parsed : Object.values(parsed)
  let added = 0
  for (const correction of incoming) {
    // Ids embed the entity, card kind and timestamp, so re-importing the same
    // export merges rather than duplicating.
    if (store.get(correction.id)) continue
    store.add(correction)
    added++
  }
  await store.flush()
  console.log(`Imported ${added} new report(s); ${store.size} held in total.`)
}

if (values.accept) {
  const correction = store.get(values.accept)
  if (!correction) {
    console.error(`No report with id ${values.accept}`)
    process.exit(1)
  }
  if (!values.body) {
    console.error('Accepting needs --body with the corrected text.')
    process.exit(1)
  }
  if (!acceptCorrection(store, cache, values.accept, values.body)) {
    console.error('Already resolved.')
    process.exit(1)
  }
  await store.flush()
  await cache.flush()
  console.log(`Accepted. Every briefing through ${correction.entityKey} now reads:\n  ${values.body}`)
}

if (values.reject) {
  if (!rejectCorrection(store, values.reject)) {
    console.error('No open report with that id.')
    process.exit(1)
  }
  await store.flush()
  console.log('Rejected. The card is shown again.')
}

if (values.list || (!values.accept && !values.reject && !values.import)) {
  const open = store.all().filter((c) => c.status === 'open')
  console.log(`${open.length} open report(s) of ${store.size} held.`)
  open.forEach(show)
}
