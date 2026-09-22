import type { TransportMode } from '../domain/types.ts'
import type { RouteRequest, RouteResult, RoutingProvider } from './types.ts'

const COSTING: Partial<Record<TransportMode, string>> = {
  walk: 'pedestrian',
  drive: 'auto',
  taxi: 'auto',
}

/** The same unhurried pace OSRM's walking legs are derived at. */
const WALKING_KMH = 4.5

/**
 * Valhalla, for legs somebody is going to walk.
 *
 * OSRM's public demo is built with one car profile and ignores the profile in
 * the URL, so every walking leg was a driving route. Measured against the
 * Google walking distances that ship inside a Wanderlog document, over the 23
 * walking legs of one Prague trip:
 *
 *              median    max
 *   OSRM        1.55x  30.67x
 *   Valhalla    1.02x   1.68x
 *
 * OSRM sent a walker 4.51km between two palaces on the same square, 150m
 * apart, and the briefing budgeted an hour for it. The same leg is now 0.25km
 * and three minutes, against Google's 0.15km and two.
 *
 * Read the units field below before trusting any of that. A first pass at
 * these numbers assumed Valhalla answers in miles, which is its default, and
 * reported every distance 1.609x too large — a comfortably plausible error
 * that made this router look barely better than the one it replaces.
 *
 * This is the OSM Foundation's public instance and shared infrastructure, so
 * it identifies itself and asks once per leg, no faster than the pipeline
 * already walks the graph.
 */
export class ValhallaProvider implements RoutingProvider {
  readonly name = 'valhalla'
  readonly #base: string
  readonly #trustDurations: boolean
  readonly #contact: string | undefined

  constructor(opts: { endpoint?: string; trustDurations?: boolean; contact?: string } = {}) {
    this.#base = opts.endpoint ?? 'https://valhalla1.openstreetmap.de'
    // Valhalla's pedestrian costing walks at 5.1km/h and does account for
    // stairs, which Prague has a great many of. Deriving at 4.5 anyway keeps
    // one pace across both routers and errs slow, which is the safe direction:
    // an overstated walk costs idle minutes, an understated one costs a train.
    this.#trustDurations = opts.trustDurations ?? false
    this.#contact = opts.contact
  }

  supports(mode: TransportMode): boolean {
    return mode in COSTING
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const costing = COSTING[req.mode]
    if (!costing) return { ok: false, reason: `valhalla has no costing for ${req.mode}` }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': this.#contact ? `trip-companion/0.1 (${this.#contact})` : 'trip-companion/0.1',
    }

    try {
      const res = await fetch(`${this.#base}/route`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locations: [
            { lat: req.from.lat, lon: req.from.lon },
            { lat: req.to.lat, lon: req.to.lon },
          ],
          costing,
          units: 'kilometers',
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return { ok: false, reason: `valhalla returned ${res.status}` }

      const body = (await res.json()) as {
        trip?: { summary?: { length?: number; time?: number } }
      }
      const summary = body.trip?.summary
      if (summary?.length === undefined || summary.time === undefined) {
        return { ok: false, reason: 'valhalla found no route' }
      }

      // `units: kilometers` is requested, so length is km. Asserting it rather
      // than assuming it would need a field the response does not carry.
      const metres = Math.round(summary.length * 1000)
      const derived = req.mode === 'walk' && !this.#trustDurations
      return {
        ok: true,
        mode: req.mode,
        durationMinutes: derived
          ? Math.max(1, Math.round(((metres / 1000) / WALKING_KMH) * 60))
          : Math.max(1, Math.round(summary.time / 60)),
        distanceMetres: metres,
      }
    } catch (err) {
      const name = (err as { name?: string }).name
      return {
        ok: false,
        reason: name === 'TimeoutError' ? 'valhalla did not answer in time' : `valhalla unreachable: ${(err as Error).message}`,
      }
    }
  }
}
