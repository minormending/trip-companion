import type { Card, Place, Source } from '../../domain/types.ts'
import { accessFrom, hoursFrom, payingFrom, type Tags } from './overpass.ts'
import { fetchOsmTags, findOsmIdentity, type LookupOptions, type OsmIdentity } from '../../geo/osmLookup.ts'
import type { CardDraft, CardProvider, CardRequest } from './types.ts'

/**
 * OpenStreetMap facts, reached without Overpass.
 *
 * Identical in output to OverpassProvider — it reuses the same three readers,
 * so a tag means the same thing whichever route fetched it — and different in
 * how it finds the element. OverpassProvider requires a place to already carry
 * an osmId, which nothing in the Wanderlog import ever sets, so it has never
 * produced a card for an imported trip. This resolves the identity itself.
 *
 * What it adds that no other source here can is payment *method*. The trip
 * document knows what a visit was budgeted at; only OSM knows the ice cream
 * shop takes Maestro and the bakery takes cash.
 *
 * It is deliberately slow: Photon is community infrastructure and gets one
 * request at a time. That is why this runs after the briefing is on screen
 * rather than in front of it.
 */

function osmSource(identity: OsmIdentity, retrieved: string): Source {
  return {
    url: `https://www.openstreetmap.org/${identity.kind}/${identity.id}`,
    title: `OpenStreetMap ${identity.kind} ${identity.id}`,
    retrieved,
  }
}

export interface ResolvedPlace {
  identity: OsmIdentity
  tags: Tags
}

export class OsmApiProvider implements CardProvider {
  readonly name = 'osm'
  readonly #byPlaceId: Map<string, ResolvedPlace>
  readonly #retrieved: string

  constructor(resolved: Map<string, ResolvedPlace>, retrieved = new Date().toISOString().slice(0, 10)) {
    this.#byPlaceId = resolved
    this.#retrieved = retrieved
  }

  get resolved(): number {
    return this.#byPlaceId.size
  }

  async draft(req: CardRequest): Promise<CardDraft | null> {
    if (req.context.subject !== 'place') return null
    const found = this.#byPlaceId.get(req.context.place.id)
    if (!found) return null

    const body =
      req.kind === 'how_to_pay'
        ? payingFrom(found.tags)
        : req.kind === 'hours'
          ? hoursFrom(found.tags)
          : req.kind === 'orientation'
            ? accessFrom(found.tags)
            : null
    if (!body) return null

    return {
      title: req.context.place.name,
      body,
      sources: [osmSource(found.identity, this.#retrieved)],
    }
  }
}

export interface ResolveProgress {
  (done: number, total: number, found: number): void
}

/**
 * Look every place up, one at a time.
 *
 * Photon's usage policy is a request per second from one client, so this waits
 * between them rather than going wide. Thirty-three stops take about forty
 * seconds, which is exactly why the briefing is already readable by then.
 */
export async function resolvePlaces(
  places: Place[],
  opts: LookupOptions & { minIntervalMs?: number; onProgress?: ResolveProgress } = {},
): Promise<Map<string, ResolvedPlace>> {
  const wait = opts.minIntervalMs ?? 1100
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, wait))
  const out = new Map<string, ResolvedPlace>()
  // The same place can appear on several days; ask about it once.
  const seen = new Map<string, ResolvedPlace | null>()

  let done = 0
  for (const place of places) {
    if (opts.signal?.aborted) break

    const key = `${place.name}@${place.coords.lat.toFixed(5)},${place.coords.lon.toFixed(5)}`
    if (seen.has(key)) {
      const cached = seen.get(key)
      if (cached) out.set(place.id, cached)
      done++
      opts.onProgress?.(done, places.length, out.size)
      continue
    }

    if (done > 0) await pause()

    // A place the reverse lookup cannot name is searched for by name, which is
    // a second Photon request. It is paced like the first: the limit is a
    // request a second from this client, not a place a second.
    const identity = await findOsmIdentity(place, { ...opts, pause })
    let resolved: ResolvedPlace | null = null
    if (identity) {
      const tags = await fetchOsmTags(identity, opts)
      // An element with no tags worth reading is not a match worth keeping.
      if (tags && Object.keys(tags).length > 0) resolved = { identity, tags }
    }

    seen.set(key, resolved)
    if (resolved) out.set(place.id, resolved)
    done++
    opts.onProgress?.(done, places.length, out.size)
  }

  return out
}

/**
 * How many cards in a finished trip came from OpenStreetMap.
 *
 * The obvious measure — cards after minus cards before — is wrong, and was
 * wrong in a way that took a warm cache to expose. Cards are cached against
 * the real-world entity, so the *second* time a trip is imported the first
 * pass already serves OSM's cards from the cache and the enrichment pass adds
 * nothing. The delta reads zero and the line said "recorded nothing new" over
 * a briefing with six OSM cards in it.
 *
 * Counting provenance answers the question actually being asked — what is in
 * this briefing because of OSM — and gives the same answer cold or warm.
 */
export function osmCardCount(cards: Card[], resolved: Map<string, ResolvedPlace>): number {
  const urls = new Set<string>()
  for (const { identity } of resolved.values()) {
    urls.add(`https://www.openstreetmap.org/${identity.kind}/${identity.id}`)
  }
  return cards.filter((card) => card.provenance.sources.some((source) => urls.has(source.url))).length
}
