import type { Coordinates, Place } from '../domain/types.ts'
import type { Tags } from '../content/providers/overpass.ts'

/**
 * Finding a place in OpenStreetMap without Overpass.
 *
 * Overpass is the obvious way and was unusable: all three public mirrors
 * failed for a whole day, and overpass-api.de answered 406 to every query with
 * and without an Accept header, which is a broken endpoint rather than a busy
 * one. Photon and the OSM API together do the same job from two services that
 * were up throughout — and Photon is already a dependency here, already
 * rate-limited, already sending a contact address.
 *
 * Two steps. Photon's reverse lookup gives the OSM identity of what is at a
 * coordinate; the OSM API gives that element's tags.
 */

const PHOTON_REVERSE = 'https://photon.komoot.io/reverse'
const PHOTON_SEARCH = 'https://photon.komoot.io/api'
const OSM_API = 'https://api.openstreetmap.org/api/0.6'

/** Photon's single letters, and the paths the OSM API uses for them. */
const ELEMENT: Record<string, 'node' | 'way' | 'relation'> = {
  N: 'node',
  W: 'way',
  R: 'relation',
}

export interface OsmIdentity {
  kind: 'node' | 'way' | 'relation'
  id: number
  /** The name OSM had, which is often not the name the traveller wrote. */
  matchedName: string
}

/** Lowercased, with accents dropped. "Bistró" and "Bistro" are one word. */
function normalise(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Abbreviations the two sources disagree about.
 *
 * The document writes "St. Vitus Cathedral" and "Church of St Giles"; OSM
 * writes "Saint Vitus Cathedral" and "Saint Giles". Czech "sv." is the same
 * word again. Three entries close four stops, and every one of them is a
 * spelling of the same word rather than a guess about what a name means.
 */
const ALIAS: Record<string, string> = { st: 'saint', ste: 'saint', sv: 'saint' }

function words(value: string): Set<string> {
  return new Set(
    normalise(value)
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((word) => ALIAS[word] ?? word),
  )
}

/** One insertion, deletion or substitution apart — no further. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let edits = 0
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (short.length === long.length) i++
    j++
  }
  return edits + (long.length - j) + (short.length - i) <= 1
}

/**
 * Is this candidate the same place, or merely near it?
 *
 * Compared as sets of words, because the two sources agree on which words a
 * place's name contains far more often than on their order or completeness.
 * Of the fifteen stops this failed on, eleven differed only by a word one side
 * carried and the other did not: "Hotel Royal Plaza" against "Royal plaza",
 * "State Opera" against "Prague State Opera", "National Gallery Prague –
 * Schwarzenberg Palace" against "National Gallery in Prague - Schwarzenberg
 * Palace".
 *
 * What replaced a prefix test, which could only ever see the front of a name
 * and matched "Grébovka" to "Grébovka (Havlíčkovy sady)" by luck of ordering.
 *
 * The floors are what keep it honest, because the failure this tier exists to
 * prevent is giving the café next door's card payments to the cathedral:
 *
 *   - a contained name needs two shared words, one of them five characters or
 *     more, so "Old Town" does not claim "Old Town Hall Tower";
 *   - a single word has to be eight characters to stand alone, so "Kolacherie"
 *     and "Grébovka" match while "Albert" cannot swallow "Albert Einstein";
 *   - one word may be a character out from another only at eight characters or
 *     more, which is "Klementinum" against OSM's "Clementinum" and nothing
 *     looser.
 */
export function namesMatch(wanted: string, candidate: string): boolean {
  const a = words(wanted)
  const b = words(candidate)
  if (a.size === 0 || b.size === 0) return false

  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  const missing = [...small].filter((word) => !big.has(word))

  if (missing.length === 0) {
    if (small.size === big.size) return true
    if (small.size === 1) return [...small][0]!.length >= 8
    return [...small].some((word) => word.length >= 5)
  }

  // Same name, spelled differently in one long word.
  if (small.size !== big.size || missing.length !== 1) return false
  const spare = [...big].filter((word) => !small.has(word))
  if (spare.length !== 1) return false
  const [x, y] = [missing[0]!, spare[0]!]
  return x.length >= 8 && y.length >= 8 && withinOneEdit(x, y)
}

/**
 * How far a searched-for name may sit from the coordinate the document gave.
 *
 * Generous, because it has to cover an aerodrome whose centre is half a
 * kilometre from its terminal, and because a name match is already required
 * before the distance is even consulted. It is not a nicety: searching for
 * "Farmers' Saturday market" returns marketplaces in Vienna and Los Angeles
 * that match the name perfectly, and this is the only thing standing between
 * them and a Prague briefing.
 */
const MAX_SEARCH_METRES = 2_000

export interface LookupOptions {
  contact?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Called between the two Photon requests, so one place cannot outrun the
   *  rate limit the caller is pacing to. */
  pause?: () => Promise<void>
}

function headers(contact: string | undefined): Record<string, string> {
  // Photon and the OSM API both ask for an identifying agent, and Photon's
  // usage policy asks for a way to be contacted.
  return { 'User-Agent': contact ? `trip-companion/0.1 (${contact})` : 'trip-companion/0.1' }
}

interface Candidate {
  kind: 'node' | 'way' | 'relation'
  id: number
  name: string
  coords?: Coordinates
}

function candidates(body: unknown): Candidate[] {
  const features = (body as { features?: unknown })?.features
  if (!Array.isArray(features)) return []

  const out: Candidate[] = []
  for (const feature of features) {
    const props = (feature as { properties?: Record<string, unknown> })?.properties
    const name = props?.['name']
    const type = props?.['osm_type']
    const id = props?.['osm_id']
    if (typeof name !== 'string' || typeof type !== 'string' || typeof id !== 'number') continue
    const kind = ELEMENT[type]
    if (!kind) continue

    const point = (feature as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates
    const coords =
      Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
        ? { lat: point[1], lon: point[0] }
        : undefined
    out.push({ kind, id, name, ...(coords ? { coords } : {}) })
  }
  return out
}

async function ask(url: string, opts: LookupOptions): Promise<Candidate[]> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(url, {
      headers: headers(opts.contact),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!res.ok) return []
    return candidates(await res.json())
  } catch {
    return []
  }
}

/** The exact name wins even where a looser match appears earlier in the list. */
function pick(wanted: string, found: Candidate[]): Candidate | null {
  return (
    found.find((c) => normalise(c.name) === normalise(wanted)) ??
    found.find((c) => namesMatch(wanted, c.name)) ??
    null
  )
}

/**
 * Which OSM element a place is, if one can be identified confidently.
 *
 * Two questions, asked in that order. *What is at this coordinate* is the
 * cheaper and safer one, so it goes first: whatever comes back is already
 * where the traveller is standing, and only the name is in doubt.
 *
 * *Where is this name* is the fallback, and it is needed more often than it
 * sounds. Photon's reverse lookup returns the nearest handful of features, and
 * for anything large that handful is the things inside it rather than the
 * thing itself: Václav Havel Airport came back as eight airport shops, JFK as
 * four access roads. Searched for by name, both resolve to their aerodrome on
 * the first hit. The answer is then checked against the coordinate, because
 * this question can be answered from the wrong continent.
 *
 * `lang=en` matters more than it looks. Without it Photon answers in Czech —
 * "Katedrála svatého Víta" for a document that says "St. Vitus Cathedral" —
 * and matching went from 9 places out of 33 to 14 when it was added.
 */
export async function findOsmIdentity(
  place: Place,
  opts: LookupOptions = {},
): Promise<OsmIdentity | null> {
  const { lat, lon } = place.coords

  const nearby = pick(place.name, await ask(`${PHOTON_REVERSE}?lat=${lat}&lon=${lon}&limit=8&lang=en`, opts))
  if (nearby) return { kind: nearby.kind, id: nearby.id, matchedName: nearby.name }
  if (opts.signal?.aborted) return null

  await opts.pause?.()
  const searched = pick(
    place.name,
    await ask(
      `${PHOTON_SEARCH}?q=${encodeURIComponent(place.name)}&lat=${lat}&lon=${lon}&limit=8&lang=en`,
      opts,
    ),
  )
  if (!searched?.coords) return null
  if (metresBetween(place.coords, searched.coords) > MAX_SEARCH_METRES) return null
  return { kind: searched.kind, id: searched.id, matchedName: searched.name }
}

/** Everything OSM records about one element. */
export async function fetchOsmTags(
  identity: OsmIdentity,
  opts: LookupOptions = {},
): Promise<Tags | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${OSM_API}/${identity.kind}/${identity.id}.json`, {
      headers: headers(opts.contact),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { elements?: Array<{ tags?: Tags }> }
    return body.elements?.[0]?.tags ?? null
  } catch {
    return null
  }
}

/** Straight-line metres, for sanity-checking a match. */
export function metresBetween(a: Coordinates, b: Coordinates): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}
