import { haversineKm } from '../geo/geocode.ts'
import { missingLegs } from '../domain/graph.ts'
import type { Leg, Place, TransportMode, Trip } from '../domain/types.ts'
import type { RoutingProvider } from './types.ts'

const WALK_MAX_KM = 1.2
const TRANSIT_MAX_KM = 30
const LONG_HAUL_KM = 600
/** Past this, a walking route is not a useful answer to a missing transit route. */
const WALK_FALLBACK_MAX_KM = 8

export interface FillReport {
  routed: number
  inferred: number
  /** Legs where transit was wanted but only a walking route could be had. */
  walkFallback: number
  /** Gaps between days that nobody travels, because they sleep instead. */
  overnight: number
  notes: string[]
}

/**
 * Mode is chosen from straight-line distance before any router is called, so a
 * 400m hop never burns a paid transit request.
 */
export function guessMode(from: Place, to: Place): TransportMode {
  const km = haversineKm(from.coords, to.coords)
  if (km <= WALK_MAX_KM) return 'walk'
  if (km <= TRANSIT_MAX_KM) return 'transit'
  if (km <= LONG_HAUL_KM) return 'rail'
  return 'flight'
}

function legId(from: Place, to: Place): string {
  return `leg:${from.id}>${to.id}`
}

/**
 * Is this gap a night rather than a journey?
 *
 * The last stop of one day and the first of the next are adjacent in the list
 * and nowhere near each other in time. The Prague briefing routed Charles
 * Bridge at half past eight in the evening to a bakery at quarter to eight the
 * next morning, and called it a 62-minute walk. Nobody walks it; they go to
 * bed. The itinerary simply does not record where they sleep.
 *
 * The exception is a journey that is itself overnight. A flight or a long
 * rail leg between two days is real — you cannot sleep at home between the
 * gate and the plane — so those are kept. Only the local modes are dropped,
 * which is the same distinction `guessMode` already draws.
 */
function spansANight(from: Place, to: Place, mode: TransportMode): boolean {
  // A trip with no day structure at all — the paste path — has nothing to
  // span, and every gap stays a journey.
  if (from.dayIndex === undefined || to.dayIndex === undefined) return false
  if (from.dayIndex === to.dayIndex) return false
  return mode === 'walk' || mode === 'transit'
}

export async function fillLegs(
  trip: Trip,
  providers: RoutingProvider[],
): Promise<{ trip: Trip; report: FillReport }> {
  const gaps = missingLegs(trip)
  const added: Leg[] = []
  const report: FillReport = { routed: 0, inferred: 0, walkFallback: 0, overnight: 0, notes: [] }

  for (const { from, to } of gaps) {
    const mode = guessMode(from, to)

    if (spansANight(from, to, mode)) {
      report.overnight++
      report.notes.push(`${from.name} to ${to.name}: different days, no leg`)
      continue
    }

    const candidates = providers.filter((p) => p.supports(mode))
    let placed = false

    for (const provider of candidates) {
      const result = await provider.route({ from: from.coords, to: to.coords, mode })
      if (result.ok) {
        const leg: Leg = {
          id: legId(from, to),
          fromPlaceId: from.id,
          toPlaceId: to.id,
          mode: result.mode,
          durationMinutes: result.durationMinutes,
          distanceMetres: result.distanceMetres,
          inferred: false,
        }
        if (result.operator) leg.operator = result.operator
        added.push(leg)
        report.routed++
        placed = true
        break
      }
      report.notes.push(`${from.name} to ${to.name}: ${result.reason}`)
    }

    // A real walking route beats a straight-line guess even when the traveller
    // will probably take the metro: it gives an honest upper bound on the time
    // and a distance that follows actual streets.
    const straightLineKm = haversineKm(from.coords, to.coords)
    if (!placed && mode !== 'walk' && straightLineKm <= WALK_FALLBACK_MAX_KM) {
      for (const provider of providers.filter((p) => p.supports('walk'))) {
        const result = await provider.route({ from: from.coords, to: to.coords, mode: 'walk' })
        if (!result.ok) continue
        added.push({
          id: legId(from, to),
          fromPlaceId: from.id,
          toPlaceId: to.id,
          mode: 'walk',
          durationMinutes: result.durationMinutes,
          distanceMetres: result.distanceMetres,
          inferred: false,
        })
        report.walkFallback++
        report.notes.push(
          `${from.name} to ${to.name}: no ${mode} data, showing the walking route instead`,
        )
        placed = true
        break
      }
    }

    if (!placed) {
      added.push({
        id: legId(from, to),
        fromPlaceId: from.id,
        toPlaceId: to.id,
        mode,
        distanceMetres: Math.round(straightLineKm * 1000),
        inferred: true,
      })
      report.inferred++
      if (candidates.length === 0) {
        report.notes.push(`${from.name} to ${to.name}: no provider handles ${mode}`)
      }
    }
  }

  return { trip: { ...trip, legs: [...trip.legs, ...added] }, report }
}
