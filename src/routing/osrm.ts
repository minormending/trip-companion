import type { TransportMode } from '../domain/types.ts'
import type { RouteRequest, RouteResult, RoutingProvider } from './types.ts'

const PROFILE: Partial<Record<TransportMode, string>> = {
  walk: 'foot',
  drive: 'driving',
  taxi: 'driving',
}

/**
 * A deliberately unhurried pace: a traveller with a bag, stopping at
 * crossings. Erring slow is the safe direction — a briefing that overstates
 * a walk costs someone a few idle minutes, one that understates it costs
 * them the train.
 */
const WALKING_KMH = 4.5

/**
 * OSRM covers street routing only — no timetables, no transit. It is keyless,
 * which makes walking legs free, and walking is the majority of legs in a
 * city itinerary.
 *
 * The public demo instance is built with a single car profile and ignores the
 * profile in the URL: /foot, /driving and /cycling return byte-identical
 * routes at roughly 20km/h. Its distances follow real streets and are usable,
 * but its durations are driving times. So walking durations are derived from
 * distance here rather than taken from the response, and `trustDurations`
 * stays off until pointed at an instance actually built with a foot profile.
 */
export class OsrmProvider implements RoutingProvider {
  readonly name = 'osrm'
  readonly #base: string
  readonly #trustDurations: boolean

  constructor(opts: { endpoint?: string; trustDurations?: boolean } = {}) {
    this.#base = opts.endpoint ?? 'https://router.project-osrm.org'
    this.#trustDurations = opts.trustDurations ?? false
  }

  supports(mode: TransportMode): boolean {
    return mode in PROFILE
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const profile = PROFILE[req.mode]
    if (!profile) return { ok: false, reason: `osrm has no profile for ${req.mode}` }

    const coords = `${req.from.lon},${req.from.lat};${req.to.lon},${req.to.lat}`
    const url = `${this.#base}/route/v1/${profile}/${coords}?overview=false`

    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'trip-companion/0.1' } })
      if (!res.ok) return { ok: false, reason: `osrm returned ${res.status}` }
      const body = (await res.json()) as {
        code?: string
        routes?: Array<{ duration?: number; distance?: number }>
      }
      const route = body.routes?.[0]
      if (body.code !== 'Ok' || !route?.duration || route.distance === undefined) {
        return { ok: false, reason: 'osrm found no route' }
      }
      const metres = Math.round(route.distance)
      const derived = req.mode === 'walk' && !this.#trustDurations
      return {
        ok: true,
        mode: req.mode,
        durationMinutes: derived
          ? Math.max(1, Math.round(metres / 1000 / WALKING_KMH * 60))
          : Math.round(route.duration / 60),
        distanceMetres: metres,
      }
    } catch (err) {
      return { ok: false, reason: `osrm unreachable: ${(err as Error).message}` }
    }
  }
}
