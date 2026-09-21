import type { Coordinates } from '../domain/types.ts'

export interface GeocodeCandidate {
  name: string
  coords: Coordinates
  /** ISO-3166 alpha-2 where the provider supplies it. */
  countryCode?: string
  label?: string
  osmType?: string
  /** OSM element identity, which is what lets us look up its real tags. */
  osmId?: number
  osmKind?: 'node' | 'way' | 'relation'
}

export interface GeocodeResult {
  query: string
  best?: GeocodeCandidate
  alternatives: GeocodeCandidate[]
  /**
   * True when the top two candidates are far apart, meaning the name is
   * genuinely ambiguous and a human should confirm before we spend money
   * enriching the wrong place.
   */
  ambiguous: boolean
}

export interface Geocoder {
  lookup(query: string, bias?: Coordinates): Promise<GeocodeResult>
}

/**
 * Tuned for buildings, not cities. The failure that matters at trip scale is
 * "Meiji Jingu" resolving to the stadium instead of the shrine 1.6km away, so
 * anything past a few hundred metres is worth one confirmation tap. Enriching
 * the wrong building is the expensive mistake; asking is the cheap one.
 */
const AMBIGUITY_M = 300

export function haversineKm(a: Coordinates, b: Coordinates): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: Record<string, unknown>
}

function toCandidate(f: PhotonFeature): GeocodeCandidate | null {
  const coords = f.geometry?.coordinates
  const props = f.properties ?? {}
  if (!coords || coords.length < 2) return null
  const [lon, lat] = coords
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  const name = typeof props['name'] === 'string' ? props['name'] : undefined
  if (!name) return null
  const parts = [props['city'], props['state'], props['country']].filter(
    (v): v is string => typeof v === 'string',
  )
  const candidate: GeocodeCandidate = { name, coords: { lat, lon } }
  if (typeof props['countrycode'] === 'string') candidate.countryCode = props['countrycode']
  if (parts.length) candidate.label = parts.join(', ')
  if (typeof props['osm_value'] === 'string') candidate.osmType = props['osm_value']
  if (typeof props['osm_id'] === 'number') candidate.osmId = props['osm_id']
  const kind = props['osm_type']
  if (kind === 'N') candidate.osmKind = 'node'
  else if (kind === 'W') candidate.osmKind = 'way'
  else if (kind === 'R') candidate.osmKind = 'relation'
  return candidate
}

/**
 * Photon is keyless and OSM-backed. Its public instance asks for a contact in
 * the User-Agent and light request rates, so calls are serialised with a delay.
 */
export class PhotonGeocoder implements Geocoder {
  readonly #endpoint: string
  readonly #userAgent: string
  readonly #minIntervalMs: number
  #lastCall = 0
  #cache = new Map<string, GeocodeResult>()

  constructor(opts: { contact?: string; endpoint?: string; minIntervalMs?: number } = {}) {
    this.#endpoint = opts.endpoint ?? 'https://photon.komoot.io/api'
    this.#userAgent = `trip-companion/0.1 (${opts.contact ?? 'unconfigured'})`
    this.#minIntervalMs = opts.minIntervalMs ?? 1100
  }

  async #throttle(): Promise<void> {
    const wait = this.#lastCall + this.#minIntervalMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.#lastCall = Date.now()
  }

  async lookup(query: string, bias?: Coordinates): Promise<GeocodeResult> {
    const key = `${query}|${bias ? `${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}` : ''}`
    const hit = this.#cache.get(key)
    if (hit) return hit

    await this.#throttle()
    const url = new URL(this.#endpoint)
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '5')
    // Without this Photon answers in the local script, which is unreadable in
    // the confirmation list and useless as a fallback display name.
    url.searchParams.set('lang', 'en')
    if (bias) {
      url.searchParams.set('lat', String(bias.lat))
      url.searchParams.set('lon', String(bias.lon))
    }

    let candidates: GeocodeCandidate[] = []
    try {
      const res = await fetch(url, { headers: { 'User-Agent': this.#userAgent } })
      if (res.ok) {
        const body = (await res.json()) as { features?: PhotonFeature[] }
        candidates = (body.features ?? [])
          .map(toCandidate)
          .filter((c): c is GeocodeCandidate => c !== null)
      }
    } catch {
      candidates = []
    }

    const result = buildResult(query, candidates)
    this.#cache.set(key, result)
    return result
  }
}

export function buildResult(query: string, candidates: GeocodeCandidate[]): GeocodeResult {
  const distinct = dedupe(candidates)
  const [best, second] = distinct
  const ambiguous =
    best !== undefined &&
    second !== undefined &&
    haversineKm(best.coords, second.coords) * 1000 > AMBIGUITY_M
  const result: GeocodeResult = { query, alternatives: distinct.slice(1), ambiguous }
  if (best) result.best = best
  return result
}

/** Photon returns the same feature under several OSM tags. Collapse them. */
function dedupe(candidates: GeocodeCandidate[]): GeocodeCandidate[] {
  const seen = new Set<string>()
  const out: GeocodeCandidate[] = []
  for (const c of candidates) {
    const key = `${c.coords.lat.toFixed(4)},${c.coords.lon.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/** Deterministic geocoder for tests and offline runs. */
export class StaticGeocoder implements Geocoder {
  readonly #table: Record<string, GeocodeCandidate[]>

  constructor(table: Record<string, GeocodeCandidate[]>) {
    this.#table = table
  }

  async lookup(query: string): Promise<GeocodeResult> {
    return buildResult(query, this.#table[query] ?? [])
  }
}
