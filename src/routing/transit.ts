import type { TransportMode } from '../domain/types.ts'
import type { RouteRequest, RouteResult, RoutingProvider } from './types.ts'

const TRANSIT_MODES: ReadonlySet<TransportMode> = new Set<TransportMode>([
  'transit',
  'rail',
  'bus',
  'metro',
  'ferry',
])

/**
 * Stands in for a paid transit router. Coverage is uneven by design — the spec
 * treats an honest "no data here" as better than a confident wrong route, so
 * this returns unavailable rather than guessing and the content layer fills in.
 */
export class NullTransitProvider implements RoutingProvider {
  readonly name = 'transit:unconfigured'
  supports(mode: TransportMode): boolean {
    return TRANSIT_MODES.has(mode)
  }
  async route(_req: RouteRequest): Promise<RouteResult> {
    return { ok: false, reason: 'no transit provider configured' }
  }
}

/** Deterministic transit routing for tests. */
export class FixedTransitProvider implements RoutingProvider {
  readonly name = 'transit:fixed'
  readonly #result: RouteResult

  constructor(result: RouteResult) {
    this.#result = result
  }

  supports(mode: TransportMode): boolean {
    return TRANSIT_MODES.has(mode)
  }
  async route(_req: RouteRequest): Promise<RouteResult> {
    return this.#result
  }
}
