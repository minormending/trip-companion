import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillLegs, guessMode } from '../src/routing/fill.ts'
import { FixedTransitProvider, NullTransitProvider } from '../src/routing/transit.ts'
import type { RouteRequest, RouteResult, RoutingProvider } from '../src/routing/types.ts'
import type { TransportMode } from '../src/domain/types.ts'
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
