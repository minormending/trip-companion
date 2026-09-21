import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { EntityCache } from './cache/entityCache.ts'
import type { Correction, Trip } from './domain/types.ts'
import { defaultDeps, runPipeline } from './pipeline.ts'
import { renderBriefing } from './render/briefing.ts'
import { BRIEFING_CSS } from './render/styles.ts'
import { escapeHtml } from './render/briefing.ts'
import type { Refusal } from './content/generate.ts'

const PORT = Number(process.env['PORT'] ?? 8787)
const CACHE_PATH = process.env['CACHE_PATH'] ?? '.cache/entities.json'

interface StoredTrip {
  trip: Trip
  refusals: Refusal[]
}

const trips = new Map<string, StoredTrip>()
const corrections: Correction[] = []
const cache = await EntityCache.open(CACHE_PATH)

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BRIEFING_CSS}
textarea { width: 100%; min-height: 16rem; font: inherit; font-size: 0.9rem; padding: 0.75rem;
  border: 1px solid var(--rule); border-radius: 8px; background: var(--card); color: var(--ink); }
input[type=text], input[type=date] { font: inherit; padding: 0.45rem 0.6rem; border: 1px solid var(--rule);
  border-radius: 6px; background: var(--card); color: var(--ink); }
label { display: block; margin: 1rem 0 0.35rem; font-size: 0.85rem; color: var(--ink-soft); }
button.primary { font: inherit; margin-top: 1.25rem; padding: 0.55rem 1.1rem; border-radius: 8px;
  border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent); cursor: pointer; }
</style></head><body><div class="wrap">${inner}</div></body></html>`
}

const IMPORT_FORM = page(
  'Trip Companion',
  `<h1>Trip Companion</h1>
<p class="sub">Paste an itinerary from anywhere. Places are geocoded, gaps between them are routed, and the result is a briefing you can print or share.</p>
<form method="post" action="/import">
<label for="text">Itinerary</label>
<textarea id="text" name="text" placeholder="Day 1&#10;09:00 Sensoji Temple&#10;Walk 15 min&#10;Tokyo Skytree&#10;&#10;Day 2&#10;Shibuya Crossing"></textarea>
<label for="title">Title</label>
<input type="text" id="title" name="title" placeholder="Tokyo, five days">
<label for="departs">Departure date</label>
<input type="date" id="departs" name="departs">
<button class="primary" type="submit">Build the briefing</button>
</form>`,
)

async function handleImport(req: IncomingMessage, res: ServerResponse) {
  const form = new URLSearchParams(await readBody(req))
  const text = form.get('text') ?? ''
  if (!text.trim()) {
    send(res, 400, page('Nothing to import', '<h1>Nothing to import</h1><p>Paste an itinerary first. <a href="/">Back</a></p>'))
    return
  }

  const deps = await defaultDeps({ cachePath: CACHE_PATH })
  deps.cache = cache

  const title = form.get('title')?.trim()
  const departs = form.get('departs')?.trim()
  const result = await runPipeline(text, deps, {
    ...(title ? { title } : {}),
    ...(departs ? { departsOn: departs } : {}),
  })
  await cache.flush()

  const token = randomUUID().slice(0, 8)
  result.trip.shareToken = token
  trips.set(token, { trip: result.trip, refusals: result.reports.content.refusals })

  res.writeHead(303, { location: `/t/${token}` })
  res.end()
}

function handleView(res: ServerResponse, token: string, interactive: boolean) {
  const stored = trips.get(token)
  if (!stored) {
    send(res, 404, page('Not found', '<h1>Not found</h1><p>No trip with that link. <a href="/">Start one</a></p>'))
    return
  }
  send(res, 200, renderBriefing(stored.trip, { refusals: stored.refusals, interactive }))
}

async function handleFlag(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req)
  let cardId = ''
  try {
    cardId = (JSON.parse(body) as { cardId?: string }).cardId ?? ''
  } catch {
    send(res, 400, '{"ok":false}', 'application/json')
    return
  }

  // The correction is recorded against the real-world entity, not this trip,
  // so the next traveller through the same place inherits the fix.
  let entityKey = ''
  for (const { trip } of trips.values()) {
    const card = trip.cards.find((c) => c.id === cardId)
    if (!card) continue
    entityKey = card.attachesTo.kind === 'place' ? card.attachesTo.placeId : card.attachesTo.legId
    cache.flag(entityKey, card.kind)
    break
  }

  corrections.push({
    id: randomUUID(),
    cardId,
    entityKey,
    claim: '',
    submittedAt: new Date().toISOString(),
    status: 'open',
  })
  await cache.flush()
  send(res, 200, JSON.stringify({ ok: true, corrections: corrections.length }), 'application/json')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  void (async () => {
    try {
      if (req.method === 'GET' && path === '/') return send(res, 200, IMPORT_FORM)
      if (req.method === 'POST' && path === '/import') return await handleImport(req, res)
      if (req.method === 'GET' && path.startsWith('/t/')) {
        return handleView(res, path.slice(3), true)
      }
      if (req.method === 'GET' && path.startsWith('/s/')) {
        return handleView(res, path.slice(3), false)
      }
      if (req.method === 'POST' && path === '/api/flag') return await handleFlag(req, res)
      if (req.method === 'POST' && path === '/api/regenerate') {
        return send(res, 200, JSON.stringify({ ok: true, queued: true }), 'application/json')
      }
      send(res, 404, page('Not found', '<h1>Not found</h1><p><a href="/">Start a trip</a></p>'))
    } catch (err) {
      send(res, 500, page('Error', `<h1>Something broke</h1><pre>${escapeHtml((err as Error).message)}</pre>`))
    }
  })()
})

server.listen(PORT, () => {
  console.log(`Trip Companion on http://localhost:${PORT}`)
  console.log(`  entity cache: ${CACHE_PATH} (${cache.size} entries)`)
})
