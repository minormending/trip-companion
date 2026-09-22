import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillLegs, guessMode } from '../src/routing/fill.ts'
import { OsrmProvider } from '../src/routing/osrm.ts'
import { FixedTransitProvider, NullTransitProvider } from '../src/routing/transit.ts'
import type { RouteRequest, RouteResult, RoutingProvider } from '../src/routing/types.ts'
import type { Place, TransportMode } from '../src/domain/types.ts'
import { place, trip } from './helpers.ts'

class FakeWalker implements RoutingProvider {
  readonly name = 'fake-walk'
  calls = 0
  supports(mode: TransportMode) {
    return mode === 'walk'
  }
  async route(_req: RouteRequest): Promise<RouteResult> {
    this.calls++
    return { ok: true, mode: 'walk', durationMinutes: 11, distanceMetres: 850 }
  }
}

test('mode is chosen from distance before any router is called', () => {
  const a = place('a', 'A', 35.7148, 139.7967)
  const near = place('b', 'B', 35.7160, 139.7990)
  const across = place('c', 'C', 35.6586, 139.7454)
  const far = place('d', 'D', 34.6937, 135.5023)
  const abroad = place('e', 'E', 48.8566, 2.3522)

  assert.equal(guessMode(a, near), 'walk')
  assert.equal(guessMode(a, across), 'transit')
  assert.equal(guessMode(a, far), 'rail')
  assert.equal(guessMode(a, abroad), 'flight')
})

test('a routed leg records duration and is not marked inferred', async () => {
  const walker = new FakeWalker()
  const t = trip([place('p1', 'A', 35.7148, 139.7967), place('p2', 'B', 35.7160, 139.7990)])
  const { trip: out, report } = await fillLegs(t, [walker])

  assert.equal(walker.calls, 1)
  assert.equal(report.routed, 1)
  assert.equal(report.inferred, 0)
  assert.equal(out.legs[0]?.durationMinutes, 11)
  assert.equal(out.legs[0]?.inferred, false)
})

test('an unserved leg falls back to an inferred straight-line estimate', async () => {
  const t = trip([place('p1', 'A', 35.7148, 139.7967), place('p2', 'B', 35.6586, 139.7454)])
  const { trip: out, report } = await fillLegs(t, [new NullTransitProvider()])

  assert.equal(report.routed, 0)
  assert.equal(report.inferred, 1)
  assert.equal(out.legs[0]?.inferred, true)
  assert.ok((out.legs[0]?.distanceMetres ?? 0) > 5000)
  assert.ok(report.notes.some((n) => n.includes('no transit provider configured')))
})

test('a transit provider serves transit legs when one is configured', async () => {
  const provider = new FixedTransitProvider({
    ok: true,
    mode: 'metro',
    durationMinutes: 23,
    distanceMetres: 8200,
    operator: 'Tokyo Metro',
  })
  const t = trip([place('p1', 'A', 35.7148, 139.7967), place('p2', 'B', 35.6586, 139.7454)])
  const { trip: out, report } = await fillLegs(t, [provider])

  assert.equal(report.routed, 1)
  assert.equal(out.legs[0]?.operator, 'Tokyo Metro')
  assert.equal(out.legs[0]?.mode, 'metro')
})

test('a walking router is never asked to serve a flight', async () => {
  const walker = new FakeWalker()
  const t = trip([place('p1', 'Tokyo', 35.7148, 139.7967), place('p2', 'Paris', 48.8566, 2.3522)])
  const { report } = await fillLegs(t, [walker])

  assert.equal(walker.calls, 0)
  assert.equal(report.inferred, 1)
  assert.ok(report.notes.some((n) => n.includes('no provider handles flight')))
})

test('existing legs are preserved and not re-routed', async () => {
  const walker = new FakeWalker()
  const t = trip(
    [place('p1', 'A', 35.7148, 139.7967), place('p2', 'B', 35.7160, 139.7990)],
    [{ id: 'stated', fromPlaceId: 'p1', toPlaceId: 'p2', mode: 'taxi', inferred: false }],
  )
  const { trip: out } = await fillLegs(t, [walker])
  assert.equal(walker.calls, 0)
  assert.equal(out.legs.length, 1)
  assert.equal(out.legs[0]?.mode, 'taxi')
})

test('an unserved short transit leg falls back to a real walking route', async () => {
  const walker = new FakeWalker()
  // ~3.8km apart: transit range, but well inside the walking-fallback limit.
  const t = trip([place('p1', 'A', 35.6764, 139.6993), place('p2', 'B', 35.6712, 139.7404)])
  const { trip: out, report } = await fillLegs(t, [new NullTransitProvider(), walker])
  assert.equal(guessMode(t.places[0]!, t.places[1]!), 'transit')

  assert.equal(report.walkFallback, 1)
  assert.equal(report.inferred, 0)
  assert.equal(out.legs[0]?.mode, 'walk')
  assert.equal(out.legs[0]?.durationMinutes, 11)
  assert.ok(report.notes.some((n) => n.includes('showing the walking route instead')))
})

test('the walking fallback does not apply across implausible distances', async () => {
  const walker = new FakeWalker()
  const t = trip([place('p1', 'Tokyo', 35.7148, 139.7967), place('p2', 'Osaka', 34.6937, 135.5023)])
  const { report } = await fillLegs(t, [walker])

  assert.equal(walker.calls, 0)
  assert.equal(report.walkFallback, 0)
  assert.equal(report.inferred, 1)
})

test('walking durations are derived from distance, not the demo server clock', async () => {
  // The public OSRM demo is built with a car profile and ignores /foot, so its
  // duration for this 2281m route is 411s: 20km/h, which is not a walk.
  const fakeOsrm = {
    async fetch() {
      return {
        ok: true,
        json: async () => ({ code: 'Ok', routes: [{ duration: 411, distance: 2281 }] }),
      }
    },
  }
  const original = globalThis.fetch
  globalThis.fetch = fakeOsrm.fetch as unknown as typeof fetch
  try {
    const provider = new OsrmProvider()
    const result = await provider.route({
      from: { lat: 35.6748, lon: 139.6996 },
      to: { lat: 35.6714, lon: 139.6952 },
      mode: 'walk',
    })
    assert.ok(result.ok)
    assert.equal(result.distanceMetres, 2281, 'street-network distance is kept')
    assert.equal(result.durationMinutes, 30, '2.281km at 4.5km/h, not 7 minutes')
  } finally {
    globalThis.fetch = original
  }
})

test('a real foot-profile instance can have its durations trusted', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ code: 'Ok', routes: [{ duration: 1680, distance: 2281 }] }),
  })) as unknown as typeof fetch
  try {
    const provider = new OsrmProvider({ trustDurations: true })
    const result = await provider.route({
      from: { lat: 0, lon: 0 },
      to: { lat: 0, lon: 1 },
      mode: 'walk',
    })
    assert.ok(result.ok)
    assert.equal(result.durationMinutes, 28)
  } finally {
    globalThis.fetch = original
  }
})

test('a very short walk still reports at least a minute', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ code: 'Ok', routes: [{ duration: 9, distance: 40 }] }),
  })) as unknown as typeof fetch
  try {
    const result = await new OsrmProvider().route({
      from: { lat: 0, lon: 0 },
      to: { lat: 0, lon: 1 },
      mode: 'walk',
    })
    assert.ok(result.ok)
    assert.equal(result.durationMinutes, 1)
  } finally {
    globalThis.fetch = original
  }
})

/**
 * A day boundary is not a journey. These were being routed as walks: Charles
 * Bridge at 20:30 to a bakery at 07:45 the next morning, 62 minutes on foot.
 */
const overnightTrip = (over: Partial<Place> = {}) => ({
  id: 't',
  title: 'Two days',
  legs: [],
  cards: [],
  places: [
    { id: 'a', name: 'Evening bar', coords: { lat: 50.086, lon: 14.411 }, dayIndex: 1 },
    { id: 'b', name: 'Morning bakery', coords: { lat: 50.075, lon: 14.438 }, dayIndex: 2, ...over },
  ] as Place[],
})

test('a gap between two days is left empty rather than walked', async () => {
  const { trip, report } = await fillLegs(overnightTrip(), [
    { name: 'never', supports: () => true, route: async () => ({ ok: true, mode: 'walk', durationMinutes: 62, distanceMetres: 4700 }) },
  ] as RoutingProvider[])

  assert.equal(trip.legs.length, 0, 'nobody walks from last night to this morning')
  assert.equal(report.overnight, 1)
  assert.equal(report.routed, 0)
  assert.match(report.notes[0] ?? '', /different days, no leg/)
})

test('an overnight journey is still a journey', async () => {
  // New York to Prague, arriving the next day. You cannot sleep at home
  // between the gate and the plane.
  const trip = {
    id: 't', title: 'Long haul', legs: [], cards: [],
    places: [
      { id: 'a', name: 'JFK', coords: { lat: 40.641, lon: -73.778 }, dayIndex: 1 },
      { id: 'b', name: 'PRG', coords: { lat: 50.102, lon: 14.263 }, dayIndex: 2 },
    ] as Place[],
  }
  const { trip: filled, report } = await fillLegs(trip, [])
  assert.equal(report.overnight, 0)
  assert.equal(filled.legs.length, 1, 'the flight survives the day boundary')
  assert.equal(filled.legs[0]?.mode, 'flight')
})

test('a trip with no day structure keeps every gap', async () => {
  const trip = {
    id: 't', title: 'Pasted', legs: [], cards: [],
    places: [
      { id: 'a', name: 'One', coords: { lat: 50.086, lon: 14.411 } },
      { id: 'b', name: 'Two', coords: { lat: 50.075, lon: 14.438 } },
    ] as Place[],
  }
  const { report } = await fillLegs(trip, [])
  assert.equal(report.overnight, 0, 'the paste path has no days to span')
})

test('two stops on the same day are still joined', async () => {
  const same = overnightTrip({ dayIndex: 1 })
  const { report } = await fillLegs(same, [])
  assert.equal(report.overnight, 0)
  assert.equal(report.inferred, 1)
})
