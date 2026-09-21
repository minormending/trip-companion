import type { Coordinates, TransportMode } from '../domain/types.ts'

export interface RouteRequest {
  from: Coordinates
  to: Coordinates
  mode: TransportMode
}

export interface RouteSuccess {
  ok: true
  mode: TransportMode
  durationMinutes: number
  distanceMetres: number
  operator?: string
}

export interface RouteUnavailable {
  ok: false
  /** Why the router could not serve this. Surfaced to the traveller verbatim. */
  reason: string
}

export type RouteResult = RouteSuccess | RouteUnavailable

export interface RoutingProvider {
  readonly name: string
  supports(mode: TransportMode): boolean
  route(req: RouteRequest): Promise<RouteResult>
}
