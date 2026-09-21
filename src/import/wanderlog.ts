import { timezoneForCountry } from '../geo/timezones.ts'
import type { Coordinates, Place, Trip } from '../domain/types.ts'

/**
 * Maps a Wanderlog trip document into a trip graph.
 *
 * The document shape is not public and the CLI passes it through untyped, so
 * this walks the structure rather than indexing fixed paths: it finds sections
 * by their displayHeading and places by the Google Places object hanging off
 * them. A nesting change upstream costs a field, not the whole import.
 *
 * The important consequence is that Wanderlog places already carry Google
 * geometry, so an import needs no geocoding at all — which also means none of
 * the ambiguity that made "Meiji Jingu" resolve to the stadium. The traveller
 * already picked the exact place.
 */

export interface WanderlogReport {
  sections: number
  places: number
  /** Entries that carried no usable coordinates and were skipped. */
  skipped: string[]
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

/** A section is an object carrying a display heading; days and buckets both. */
function isSection(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value['displayHeading'] === 'string'
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
function collectPlaces(node: unknown, out: Extracted[], seen: Set<unknown>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPlaces(item, out, seen)
    return
  }
  if (!isRecord(node) || seen.has(node)) return
  seen.add(node)

  const candidate = isRecord(node['place']) ? (node['place'] as Record<string, unknown>) : undefined
  if (candidate) {
    const coords = coordsFrom(candidate)
    const name = candidate['name']
    if (coords && typeof name === 'string' && name.trim()) {
      const extracted: Extracted = { name: name.trim(), coords }
      const note = noteText(node['text'] ?? node['note'])
      if (note) extracted.note = note
      const region = countryFrom(candidate)
      if (region) extracted.region = region
      const time = timeFrom(node)
      if (time) extracted.time = time
      out.push(extracted)
      return
    }
  }

  for (const value of Object.values(node)) collectPlaces(value, out, seen)
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

export function tripFromWanderlog(
  document: unknown,
  opts: { id?: string; title?: string; departsOn?: string } = {},
): { trip: Trip; report: WanderlogReport } {
  const root = isRecord(document) && isRecord(document['data']) ? document['data'] : document
  const doc = isRecord(root) ? root : {}

  const sections: Array<Record<string, unknown>> = []
  findSections(doc, sections, new Set())

  const report: WanderlogReport = { sections: sections.length, places: 0, skipped: [] }
  const places: Place[] = []
  let index = 0
  let dayIndex = 0

  // Standing buckets ("Places to visit", "Notes") are not days. Keeping them
  // would scatter unscheduled places through the itinerary as if they were
  // stops, so they are collected after the dated days rather than among them.
  const dated = sections.filter((s) => s['type'] === 'normal')
  const ordered = dated.length > 0 ? dated : sections

  for (const section of ordered) {
    const found: Extracted[] = []
    collectPlaces(section, found, new Set())
    if (found.length === 0) continue
    dayIndex++

    for (const entry of found) {
      const place: Place = {
        id: slugId(entry.name, index++),
        name: entry.name,
        coords: entry.coords,
        dayIndex,
      }
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
  const root = isRecord(document) && isRecord(document['data']) ? document['data'] : document
  if (isRecord(root) && typeof root['key'] === 'string') return root['key']
  return undefined
}
