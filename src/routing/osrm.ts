import type { TransportMode } from '../domain/types.ts'
import type { RouteRequest, RouteResult, RoutingProvider } from './types.ts'

const PROFILE: Partial<Record<TransportMode, string>> = {
  walk: 'foot',
  drive: 'driving',
  taxi: 'driving',
}

/**
 * OSRM covers street routing only — no timetables, no transit. It is keyless,
 * which makes walking legs free, and walking is the majority of legs in a
 * city itinerary.
 */
export class OsrmProvider implements RoutingProvider {
  readonly name = 'osrm'
  readonly #base: string

  constructor(opts: { endpoint?: string } = {}) {
    this.#base = opts.endpoint ?? 'https://router.project-osrm.org'
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
      return {
        ok: true,
        mode: req.mode,
        durationMinutes: Math.round(route.duration / 60),
        distanceMetres: Math.round(route.distance),
      }
    } catch (err) {
      return { ok: false, reason: `osrm unreachable: ${(err as Error).message}` }
    }
  }
}
