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

/**
 * Names compared with the accents and punctuation removed.
 *
 * "Crème de la Crème - zmrzlinový salon" and "Crème de la Crème" are the same
 * shop; "Bistró Loreta" and "Bistro Loreta" are the same bistro.
 */
function normalise(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Is this candidate the same place, or merely near it?
 *
 * Exact first, then one prefix either way, and nothing looser. Matching on
 * distance alone would attach the café next door's card payments to the
 * cathedral, which is worse than having no card: a wrong operational fact is
 * the one failure this whole tier exists to prevent.
 *
 * The prefix rule needs six characters because "U" and "Na" are whole place
 * names in Czech and would otherwise match half a street.
 */
export function namesMatch(wanted: string, candidate: string): boolean {
  const a = normalise(wanted)
  const b = normalise(candidate)
  if (!a || !b) return false
  if (a === b) return true
  if (b.length < 6 || a.length < 6) return false
  return a.startsWith(b) || b.startsWith(a)
}

export interface LookupOptions {
  contact?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

function headers(contact: string | undefined): Record<string, string> {
  // Photon and the OSM API both ask for an identifying agent, and Photon's
  // usage policy asks for a way to be contacted.
  return { 'User-Agent': contact ? `trip-companion/0.1 (${contact})` : 'trip-companion/0.1' }
}

/**
 * Which OSM element a place is, if one can be identified confidently.
 *
 * `lang=en` matters more than it looks. Without it Photon answers in Czech —
 * "Katedrála svatého Víta" for a document that says "St. Vitus Cathedral" —
 * and matching went from 9 places out of 33 to 14 when it was added.
 */
export async function findOsmIdentity(
  place: Place,
  opts: LookupOptions = {},
): Promise<OsmIdentity | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const url = `${PHOTON_REVERSE}?lat=${place.coords.lat}&lon=${place.coords.lon}&limit=8&lang=en`

  let body: unknown
  try {
    const res = await doFetch(url, {
      headers: headers(opts.contact),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!res.ok) return null
    body = await res.json()
  } catch {
    return null
  }

  const features = (body as { features?: unknown })?.features
  if (!Array.isArray(features)) return null

  for (const pass of ['exact', 'prefix'] as const) {
    for (const feature of features) {
      const props = (feature as { properties?: Record<string, unknown> })?.properties
      const name = props?.['name']
      const type = props?.['osm_type']
      const id = props?.['osm_id']
      if (typeof name !== 'string' || typeof type !== 'string' || typeof id !== 'number') continue
      const kind = ELEMENT[type]
      if (!kind) continue

      const exact = normalise(name) === normalise(place.name)
      if (pass === 'exact' ? exact : namesMatch(place.name, name)) {
        return { kind, id, matchedName: name }
      }
    }
  }
  return null
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
