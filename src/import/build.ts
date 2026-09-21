import type { GeocodeCandidate, Geocoder } from '../geo/geocode.ts'
import { emptyTrip } from '../domain/graph.ts'
import type { Coordinates, Leg, Place, Trip } from '../domain/types.ts'
import { timezoneForCountry } from '../geo/timezones.ts'
import { parseItinerary, type ParsedItinerary } from './parse.ts'

export interface UnresolvedPlace {
  query: string
  dayIndex: number
}

/**
 * An ambiguous match, carrying enough to actually offer the choice: which
 * place in the trip it is, what was picked, and what else it could be.
 * Reported before routing or card generation so the wrong building never
 * gets enriched.
 */
export interface PendingConfirmation {
  placeId: string
  query: string
  dayIndex: number
  chosen: GeocodeCandidate
  alternatives: GeocodeCandidate[]
}

export interface BuildReport {
  resolved: number
  unresolved: UnresolvedPlace[]
  needsConfirmation: PendingConfirmation[]
}

function slugId(prefix: string, name: string, index: number): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${prefix}:${index}:${slug || 'place'}`
}

/**
 * Geocodes in itinerary order, biasing each lookup toward the previous
 * resolved point. A trip is almost always geographically clustered, so this
 * turns "Victoria" from a coin flip into the one a few streets away.
 */
export type ProgressFn = (stage: string, done: number, total: number) => void

export async function buildTrip(
  parsed: ParsedItinerary,
  geocoder: Geocoder,
  opts: { id?: string; title?: string; departsOn?: string; onProgress?: ProgressFn } = {},
): Promise<{ trip: Trip; report: BuildReport }> {
  const trip = emptyTrip(opts.id ?? `trip:${Date.now()}`, opts.title ?? parsed.title ?? 'Untitled trip')
  if (opts.departsOn) trip.departsOn = opts.departsOn

  const report: BuildReport = { resolved: 0, unresolved: [], needsConfirmation: [] }
  const places: Place[] = []
  const legs: Leg[] = []
  let bias: Coordinates | undefined
  let index = 0
  const total = parsed.days.reduce(
    (n, d) => n + d.entries.filter((e) => e.type === 'place').length,
    0,
  )
  let seen = 0

  for (const day of parsed.days) {
    let previousPlaceId: string | undefined =
      places.length > 0 ? places[places.length - 1]?.id : undefined

    for (const entry of day.entries) {
      if (entry.type === 'transport') {
        // An explicit transport line means the traveller already said how they
        // are getting there, so routing must not overwrite it later.
        const from = previousPlaceId
        if (from) {
          legs.push({
            id: `leg:stated:${legs.length}`,
            fromPlaceId: from,
            toPlaceId: '',
            mode: entry.mode,
            ...(entry.durationMinutes !== undefined
              ? { durationMinutes: entry.durationMinutes }
              : {}),
            inferred: false,
          })
        }
        continue
      }

      opts.onProgress?.(`Locating ${entry.name}`, seen, total)
      const result = await geocoder.lookup(entry.name, bias)
      seen++
      if (!result.best) {
        report.unresolved.push({ query: entry.name, dayIndex: day.index })
        continue
      }

      const id = slugId('place', entry.name, index++)
      const place: Place = { id, name: entry.name, coords: result.best.coords, dayIndex: day.index }
      if (result.best.countryCode) {
        place.region = result.best.countryCode
        const tz = timezoneForCountry(result.best.countryCode)
        if (tz) place.timezone = tz
      }
      if (entry.time) place.arrive = entry.time
      places.push(place)
      report.resolved++
      bias = result.best.coords

      if (result.ambiguous) {
        report.needsConfirmation.push({
          placeId: id,
          query: entry.name,
          dayIndex: day.index,
          chosen: result.best,
          alternatives: result.alternatives,
        })
      }

      const pending = legs[legs.length - 1]
      if (pending && pending.toPlaceId === '') pending.toPlaceId = id
      previousPlaceId = id
    }
  }

  trip.places = places
  trip.legs = legs.filter((l) => l.toPlaceId !== '' && l.fromPlaceId !== '')
  return { trip, report }
}

export async function importFromText(
  text: string,
  geocoder: Geocoder,
  opts: { id?: string; title?: string; departsOn?: string; onProgress?: ProgressFn } = {},
): Promise<{ trip: Trip; report: BuildReport; parsed: ParsedItinerary }> {
  const parsed = parseItinerary(text)
  const { trip, report } = await buildTrip(parsed, geocoder, opts)
  return { trip, report, parsed }
}

/**
 * Applies a traveller's confirmations. Runs before routing and card
 * generation, so nothing has yet been computed against the wrong coordinates.
 */
export function applyChoices(
  trip: Trip,
  choices: Array<{ placeId: string; candidate: GeocodeCandidate }>,
): Trip {
  if (choices.length === 0) return trip
  const byId = new Map(choices.map((c) => [c.placeId, c.candidate]))

  return {
    ...trip,
    places: trip.places.map((place) => {
      const pick = byId.get(place.id)
      if (!pick) return place
      const next: Place = { ...place, coords: pick.coords }
      if (pick.countryCode) {
        next.region = pick.countryCode
        const tz = timezoneForCountry(pick.countryCode)
        if (tz) next.timezone = tz
      }
      return next
    }),
  }
}
