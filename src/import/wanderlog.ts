import { timezoneForCountry } from '../geo/timezones.ts'
import type { Coordinates, Place, Trip } from '../domain/types.ts'

/**
 * Maps a Wanderlog trip document into a trip graph.
 *
 * The document shape is not public and the CLI passes it through untyped, so
 * this walks the structure rather than indexing fixed paths: it finds sections
 * by their heading and places by the Google Places object hanging off them. A
 * nesting change upstream costs a field, not the whole import.
 *
 * The important consequence is that Wanderlog places already carry Google
 * geometry, so an import needs no geocoding at all — which also means none of
 * the ambiguity that made "Meiji Jingu" resolve to the stadium. The traveller
 * already picked the exact place.
 *
 * Every field name here was read off a real document from
 * /api/tripPlans/<key>?clientSchemaVersion=2, not off the CLI's types. The
 * first version of this file was written from the types and matched nothing:
 * the heading field is `heading`, not `displayHeading`, and the envelope is
 * `tripPlan`, not `data`. Both mistakes were invisible because the test fixture
 * had been invented from the same types. test/wanderlog.test.ts now runs
 * against a verbatim excerpt of a real trip so that cannot recur.
 */

export interface WanderlogReport {
  sections: number
  places: number
  /** Entries that carried a name but no usable coordinates. */
  skipped: string[]
  /** Places held in standing buckets rather than on a day. */
  unscheduled: number
  /**
   * Places whose country component disagrees with the rest of the trip.
   *
   * Reported, never corrected. Some are genuine — the outbound airport is in
   * another country by definition — and some are upstream data errors: the
   * Prague document used for the fixture tags four Czech places `US`. Guessing
   * which is which is exactly the kind of invention the content tiers forbid.
   */
  regionConflicts: Array<{ name: string; region: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Quill delta: {"ops":[{"insert":"…"}]}. A bare string is stored verbatim too. */
export function noteText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!isRecord(value) || !Array.isArray(value['ops'])) return undefined
  const text = (value['ops'] as unknown[])
    .map((op) => (isRecord(op) && typeof op['insert'] === 'string' ? op['insert'] : ''))
    .join('')
    .trim()
  return text || undefined
}

export function coordsFrom(place: Record<string, unknown>): Coordinates | undefined {
  const geometry = place['geometry']
  if (isRecord(geometry)) {
    const location = geometry['location']
    if (isRecord(location)) {
      const lat = location['lat']
      const lng = location['lng']
      if (typeof lat === 'number' && typeof lng === 'number') return { lat, lon: lng }
    }
  }
  // Some payloads carry flattened coordinates instead of a Google geometry.
  const lat = place['latitude'] ?? place['lat']
  const lon = place['longitude'] ?? place['lng'] ?? place['lon']
  if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon }
  return undefined
}

function countryFrom(place: Record<string, unknown>): string | undefined {
  const components = place['address_components']
  if (Array.isArray(components)) {
    for (const part of components) {
      if (!isRecord(part)) continue
      const types = part['types']
      if (Array.isArray(types) && types.includes('country') && typeof part['short_name'] === 'string') {
        return part['short_name'].toLowerCase()
      }
    }
  }
  const formatted = place['formatted_address']
  if (typeof formatted === 'string') {
    const tail = formatted.split(',').pop()?.trim()
    if (tail && tail.length === 2) return tail.toLowerCase()
  }
  return undefined
}

interface Extracted {
  name: string
  coords: Coordinates
  note?: string
  region?: string
  time?: string
}

/** A section is an object carrying a heading; days and buckets both.
 *
 *  Real documents use `heading`, which is often the empty string on a day —
 *  the day is labelled by its `date` instead. `displayHeading` is accepted
 *  because the CLI's types name it and an older payload may still use it. */
function isSection(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (typeof value['heading'] === 'string' || typeof value['displayHeading'] === 'string')
  )
}

/** Days say so: `mode: "dayPlan"`, and they carry the date. Everything else is
 *  a standing bucket, whatever its `type` says. In the Prague document eleven
 *  of fourteen sections are `type: "normal"` and only five of those are days;
 *  "Places to visit", "Views" and "Food" are the rest, and several of their
 *  entries are notes explaining why they were *dropped* from the itinerary.
 *  Filtering on `type` alone put thirty rejected candidates ahead of the trip. */
function isDay(section: Record<string, unknown>): boolean {
  return section['mode'] === 'dayPlan'
}

function timeFrom(entry: Record<string, unknown>): string | undefined {
  for (const key of ['startTime', 'start_time', 'time']) {
    const raw = entry[key]
    if (typeof raw === 'string') {
      const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim())
      if (match) return `${match[1]!.padStart(2, '0')}:${match[2]}`
    }
  }
  return undefined
}

/** Depth-first walk collecting every place-bearing entry under a node. */
function collectPlaces(node: unknown, out: Extracted[], seen: Set<unknown>, skipped: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPlaces(item, out, seen, skipped)
    return
  }
  if (!isRecord(node) || seen.has(node)) return
  seen.add(node)

  const candidate = isRecord(node['place']) ? (node['place'] as Record<string, unknown>) : undefined
  if (candidate) {
    const coords = coordsFrom(candidate)
    const name = candidate['name']
    if (typeof name === 'string' && name.trim()) {
      if (coords) {
        const extracted: Extracted = { name: name.trim(), coords }
        const note = noteText(node['text'] ?? node['note'])
        if (note) extracted.note = note
        const region = countryFrom(candidate)
        if (region) extracted.region = region
        const time = timeFrom(node)
        if (time) extracted.time = time
        out.push(extracted)
      } else {
        // Named but unplaceable. Recorded rather than dropped in silence,
        // because a missing stop is the kind of thing a traveller notices at
        // the wrong moment.
        skipped.push(name.trim())
      }
      return
    }
  }

  for (const value of Object.values(node)) collectPlaces(value, out, seen, skipped)
}

function findSections(node: unknown, out: Array<Record<string, unknown>>, seen: Set<unknown>): void {
  if (Array.isArray(node)) {
    for (const item of node) findSections(item, out, seen)
    return
  }
  if (!isRecord(node) || seen.has(node)) return
  seen.add(node)
  if (isSection(node)) {
    out.push(node)
    return
  }
  for (const value of Object.values(node)) findSections(value, out, seen)
}

function slugId(name: string, index: number): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `place:${index}:${slug || 'place'}`
}

/** The payload sits under `tripPlan` on /api/tripPlans/<key>, and under `data`
 *  on most other routes. Either, or the bare document. */
function unwrap(document: unknown): Record<string, unknown> {
  if (!isRecord(document)) return {}
  for (const key of ['tripPlan', 'data']) {
    const inner = document[key]
    if (isRecord(inner)) return inner
  }
  return document
}

export function tripFromWanderlog(
  document: unknown,
  opts: { id?: string; title?: string; departsOn?: string } = {},
): { trip: Trip; report: WanderlogReport } {
  const doc = unwrap(document)

  const sections: Array<Record<string, unknown>> = []
  // Only the itinerary, so the walk cannot wander into `resources`, which
  // carries hundreds of recommended places the traveller never chose.
  findSections(isRecord(doc['itinerary']) ? doc['itinerary'] : doc, sections, new Set())

  const report: WanderlogReport = {
    sections: sections.length,
    places: 0,
    skipped: [],
    unscheduled: 0,
    regionConflicts: [],
  }
  const places: Place[] = []
  let index = 0
  let dayIndex = 0

  const days = sections.filter(isDay)
  // Days first, in order, then the buckets — which keep their places (the
  // traveller curated them, notes and all) but get no dayIndex, because they
  // are not on any day.
  const ordered = days.length > 0 ? [...days, ...sections.filter((s) => !isDay(s))] : sections

  for (const section of ordered) {
    const found: Extracted[] = []
    collectPlaces(section, found, new Set(), report.skipped)
    if (found.length === 0) continue
    const scheduled = days.length === 0 || isDay(section)
    if (scheduled) dayIndex++

    for (const entry of found) {
      const place: Place = {
        id: slugId(entry.name, index++),
        name: entry.name,
        coords: entry.coords,
      }
      if (scheduled) place.dayIndex = dayIndex
      else report.unscheduled++
      if (entry.time) place.arrive = entry.time
      if (entry.region) {
        place.region = entry.region
        const tz = timezoneForCountry(entry.region)
        if (tz) place.timezone = tz
      }
      places.push(place)
      report.places++
    }
  }

  // Whichever country most of the trip is in. Anything else is worth a look.
  const counts = new Map<string, number>()
  for (const p of places) if (p.region) counts.set(p.region, (counts.get(p.region) ?? 0) + 1)
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (dominant) {
    for (const p of places) {
      if (p.region && p.region !== dominant) report.regionConflicts.push({ name: p.name, region: p.region })
    }
  }

  const title =
    opts.title ??
    (typeof doc['title'] === 'string' && doc['title'].trim() ? doc['title'].trim() : 'Wanderlog trip')
  const departsOn =
    opts.departsOn ?? (typeof doc['startDate'] === 'string' ? doc['startDate'].slice(0, 10) : undefined)

  const trip: Trip = {
    id: opts.id ?? `trip:wanderlog:${Date.now()}`,
    title,
    places,
    legs: [],
    cards: [],
  }
  if (departsOn) trip.departsOn = departsOn
  return { trip, report }
}

/** The short id in wanderlog.com/plan/<key>. */
export function wanderlogKey(document: unknown): string | undefined {
  const root = unwrap(document)
  return typeof root['key'] === 'string' ? root['key'] : undefined
}
