import type { Place, Source, Trip } from '../../domain/types.ts'
import type { CardDraft, CardProvider, CardRequest } from './types.ts'

export type Tags = Record<string, string>

export interface OverpassFetcher {
  (query: string): Promise<Array<{ type: string; id: number; tags?: Tags }>>
}

/**
 * Overpass is donated community capacity and sheds load hard: a 504 lasting
 * tens of minutes is routine, not exceptional. Mirrors are tried in turn and
 * retried once on a load-shedding status. This is also why the entity cache
 * matters operationally, not just commercially — once a place's facts are
 * cached they survive the source being down, and a pre-launch warm pass over
 * the launch cities turns a flaky dependency into a local lookup.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const RETRY_STATUS = new Set([429, 502, 503, 504])

/**
 * A stalled mirror must not hold the whole briefing. Without this a hung
 * connection blocks every stage behind it, which in the browser is a spinner
 * that never resolves — worse than the outage it is reacting to.
 */
const REQUEST_TIMEOUT_MS = 12_000

function elementKey(kind: string, id: number): string {
  return `${kind}/${id}`
}

/** OSM is a citable primary source, which is what makes tier-1 cards possible. */
function osmSource(kind: string, id: number, retrieved: string): Source {
  return {
    url: `https://www.openstreetmap.org/${kind}/${id}`,
    title: `OpenStreetMap ${kind} ${id}`,
    retrieved,
  }
}

function joinSentences(parts: string[]): string {
  return parts
    .map((p) => (p.endsWith('.') ? p : `${p}.`))
    .join(' ')
}

/**
 * Payment is the archetypal tier-1 card: wrong, and somebody is stuck at a
 * machine they cannot use. Every clause below is read straight off a recorded
 * tag — nothing is inferred from what is usually true elsewhere.
 */
export function payingFrom(tags: Tags): string | null {
  const parts: string[] = []
  const fee = tags['fee']
  const charge = tags['charge']

  if (fee === 'no') parts.push('Free to enter')
  else if (fee === 'yes' && charge) parts.push(`Entry costs ${charge}`)
  else if (fee === 'yes') parts.push('There is an entry fee, but the amount is not recorded')
  else if (charge) parts.push(`Charge: ${charge}`)

  const cash = tags['payment:cash']
  const cards = tags['payment:cards'] ?? tags['payment:credit_cards']
  const coins = tags['payment:coins']
  const notes = tags['payment:notes']
  const contactless = tags['payment:contactless']

  if (coins === 'yes' && notes === 'no') parts.push('The machine takes coins only, not notes')
  else if (coins === 'yes') parts.push('Coins are accepted')
  if (cash === 'only' || (cash === 'yes' && cards === 'no')) parts.push('Cash only')
  else if (cards === 'yes') parts.push('Cards are accepted')
  if (contactless === 'yes') parts.push('Contactless works')
  else if (contactless === 'no') parts.push('Contactless does not work here')

  return parts.length > 0 ? joinSentences(parts) : null
}

export function hoursFrom(tags: Tags): string | null {
  const hours = tags['opening_hours']
  if (!hours) return null
  if (hours === '24/7') return 'Open at all hours'
  // OSM's opening_hours grammar is far richer than it looks, and a half-right
  // parse of it is exactly the confident-wrong failure tier 1 exists to avoid.
  // The recorded value is passed through verbatim and attributed.
  return `Opening hours are recorded as ${hours}`
}

export function accessFrom(tags: Tags): string | null {
  const wheelchair = tags['wheelchair']
  if (wheelchair === 'yes') return 'Step-free access is recorded here'
  if (wheelchair === 'limited') return 'Step-free access is recorded as limited'
  if (wheelchair === 'no') return 'No step-free access is recorded here'
  return null
}

/**
 * Reads recorded facts from OpenStreetMap. Fetches every place in the trip in
 * one request, because Overpass is donated community capacity.
 *
 * Note on licensing: OSM data is ODbL. Attribution is required, and the
 * share-alike terms bite on a derived *database*, which the entity cache
 * arguably becomes. Worth legal review before this ships commercially.
 */
export class OverpassProvider implements CardProvider {
  readonly name = 'openstreetmap'
  readonly #fetcher: OverpassFetcher
  readonly #tags = new Map<string, Tags>()
  #retrieved = new Date().toISOString().slice(0, 10)

  constructor(opts: { fetcher?: OverpassFetcher; endpoints?: string[] } = {}) {
    this.#fetcher = opts.fetcher ?? defaultFetcher(opts.endpoints ?? ENDPOINTS)
  }

  async prime(trip: Trip): Promise<void> {
    const wanted = trip.places.filter((p) => p.osmId !== undefined && p.osmKind)
    if (wanted.length === 0) return

    const selectors = wanted.map((p) => `${p.osmKind}(${p.osmId});`).join('')
    const query = `[out:json][timeout:25];(${selectors});out tags center;`

    const elements = await this.#fetcher(query)
    this.#retrieved = new Date().toISOString().slice(0, 10)
    for (const element of elements) {
      if (element.tags) this.#tags.set(elementKey(element.type, element.id), element.tags)
    }
  }

  tagsFor(place: Place): Tags | undefined {
    if (place.osmId === undefined || !place.osmKind) return undefined
    return this.#tags.get(elementKey(place.osmKind, place.osmId))
  }

  async draft(req: CardRequest): Promise<CardDraft | null> {
    if (req.context.subject !== 'place') return null
    const place = req.context.place
    const tags = this.tagsFor(place)
    if (!tags || place.osmId === undefined || !place.osmKind) return null

    const body =
      req.kind === 'how_to_pay'
        ? payingFrom(tags)
        : req.kind === 'hours'
          ? hoursFrom(tags)
          : req.kind === 'orientation'
            ? accessFrom(tags)
            : null

    if (!body) return null

    return {
      title: place.name,
      body,
      sources: [osmSource(place.osmKind, place.osmId, this.#retrieved)],
    }
  }
}

function defaultFetcher(endpoints: string[]): OverpassFetcher {
  return async (query: string) => {
    let last = 'no endpoint tried'
    for (const endpoint of endpoints) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const url = `${endpoint}?data=${encodeURIComponent(query)}`
          // No Accept header: Overpass's content negotiation answers 406 to an
          // explicit application/json. It returns JSON anyway, because the
          // query itself says [out:json].
          const res = await fetch(url, {
            headers: { 'User-Agent': 'trip-companion/0.1' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          if (res.ok) {
            const body = (await res.json()) as {
              elements?: Array<{ type: string; id: number; tags?: Tags }>
            }
            return body.elements ?? []
          }
          last = `${new URL(endpoint).host} returned ${res.status}`
          if (!RETRY_STATUS.has(res.status)) break
          await new Promise((r) => setTimeout(r, 1500))
        } catch (err) {
          last = `${new URL(endpoint).host} unreachable: ${(err as Error).message}`
          break
        }
      }
    }
    throw new Error(last)
  }
}
