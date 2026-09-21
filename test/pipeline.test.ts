import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EntityCache } from '../src/cache/entityCache.ts'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import { StaticGeocoder, type GeocodeCandidate } from '../src/geo/geocode.ts'
import { runPipeline, regenerationTargets, type PipelineDeps } from '../src/pipeline.ts'
import { NullTransitProvider } from '../src/routing/transit.ts'
import type { Card } from '../src/domain/types.ts'
import { place, trip, SOURCE, StubProvider } from './helpers.ts'

const jp = (name: string, lat: number, lon: number): GeocodeCandidate[] => [
  { name, coords: { lat, lon }, countryCode: 'jp', label: 'Tokyo, Japan' },
]

const GEO = new StaticGeocoder({
  'Sensoji Temple': jp('Sensoji Temple', 35.7148, 139.7967),
  'Tokyo Skytree': jp('Tokyo Skytree', 35.7101, 139.8107),
  'Sumida Park': jp('Sumida Park', 35.7133, 139.8005),
  'Shibuya Crossing': jp('Shibuya Crossing', 35.6595, 139.7004),
  'Meiji Jingu': jp('Meiji Jingu', 35.6764, 139.6993),
  'Yoyogi Park': jp('Yoyogi Park', 35.6712, 139.6949),
  'Tsukiji Outer Market': jp('Tsukiji Outer Market', 35.6654, 139.7707),
  'teamLab Planets': jp('teamLab Planets', 35.6487, 139.7906),
})

const ITINERARY = await readFile(new URL('../fixtures/tokyo.txt', import.meta.url), 'utf8')

function offlineDeps(cache?: EntityCache): PipelineDeps {
  return {
    geocoder: GEO,
    routers: [new NullTransitProvider()],
    providers: [new DeterministicProvider()],
    ...(cache ? { cache } : {}),
  }
}

test('a pasted itinerary becomes a rendered briefing end to end', async () => {
  const result = await runPipeline(ITINERARY, offlineDeps(), {
    departsOn: '2026-11-03',
    now: new Date('2026-09-20T00:00:00Z'),
  })

  assert.equal(result.reports.build.resolved, 8)
  assert.equal(result.reports.build.unresolved.length, 0)
  assert.equal(result.trip.places.length, 8)
  assert.ok(result.trip.legs.length > 0)
  assert.ok(result.html.startsWith('<!doctype html>'))
  assert.ok(result.html.includes('Sensoji Temple'))
  assert.ok(result.html.includes('Day 3'))
})

test('the title comes from the itinerary when none is supplied', async () => {
  const result = await runPipeline(ITINERARY, offlineDeps(), { now: new Date('2026-09-20T00:00:00Z') })
  assert.equal(result.trip.title, 'Tokyo, five days')
})

test('with no transit provider, every non-walking leg is honestly marked inferred', async () => {
  const result = await runPipeline(ITINERARY, offlineDeps(), { now: new Date('2026-09-20T00:00:00Z') })
  assert.equal(result.reports.fill.routed, 0)
  assert.ok(result.reports.fill.inferred > 0)

  // Every leg is either one the traveller stated themselves or one we filled
  // in and marked as an estimate. None claims a routed duration it never got.
  const stated = result.trip.legs.filter((l) => l.id.startsWith('leg:stated:'))
  const filled = result.trip.legs.filter((l) => !l.id.startsWith('leg:stated:'))
  assert.ok(stated.length > 0 && filled.length > 0)
  assert.ok(filled.every((l) => l.inferred), 'gap-filled legs are marked inferred')
  assert.ok(filled.every((l) => l.durationMinutes === undefined), 'no invented durations')
})

test('the offline run publishes no unsourced operational cards', async () => {
  const result = await runPipeline(ITINERARY, offlineDeps(), { now: new Date('2026-09-20T00:00:00Z') })
  const operational = result.trip.cards.filter((c) => c.provenance.tier === 'operational')
  assert.equal(operational.length, 0, 'nothing operational is published without a source')
  assert.ok(result.trip.cards.some((c) => c.kind === 'photo'), 'computed cards still appear')
})

test('photo cards are computed for the departure date', async () => {
  const result = await runPipeline(ITINERARY, offlineDeps(), {
    departsOn: '2026-11-03',
    now: new Date('2026-09-20T00:00:00Z'),
  })
  const photo = result.trip.cards.find((c) => c.kind === 'photo')
  assert.ok(photo)
  assert.match(photo.body, /Low warm light/)
})

test('the entity cache persists across runs and to disk', async () => {
  const path = join(tmpdir(), `trip-cache-${Date.now()}.json`)
  try {
    const cache = await EntityCache.open(path)
    const provider = new StubProvider('sourced', ['how_to_pay'], {
      title: 'Paying',
      body: 'Exact change only.',
      sources: [SOURCE],
    })
    const deps = { ...offlineDeps(cache), providers: [provider] }

    const first = await runPipeline(ITINERARY, deps, { now: new Date('2026-09-20T00:00:00Z') })
    assert.ok(first.reports.content.generated > 0)
    await cache.flush()

    const reopened = await EntityCache.open(path)
    assert.ok(reopened.size > 0, 'cache survived a restart')

    const second = await runPipeline(ITINERARY, { ...deps, cache: reopened }, {
      now: new Date('2026-09-20T00:00:00Z'),
    })
    assert.ok(second.reports.content.fromCache > 0, 'second run reuses the stored cards')
  } finally {
    await rm(path, { force: true })
  }
})

test('the T-2 pass narrows to the tiers that strand people', () => {
  const old = (tier: Card['provenance']['tier'], kind: Card['kind']): Card => ({
    id: `c:${kind}`,
    attachesTo: { kind: 'place', placeId: 'p1' },
    kind,
    title: 't',
    body: 'b',
    provenance: { tier, sources: [], verifiedAt: '2025-01-01', confidence: 0.8 },
  })
  const t = trip(
    [place('p1', 'A', 0, 0)],
    [],
    [old('operational', 'how_to_pay'), old('practical', 'watch_for'), old('colour', 'history')],
  )
  const now = new Date('2026-09-20T00:00:00Z')

  assert.equal(regenerationTargets(t, 'T-14', now).length, 2)
  assert.equal(regenerationTargets(t, 'T-2', now).length, 1)
  assert.equal(regenerationTargets(t, 'T-2', now)[0]?.provenance.tier, 'operational')
})

test('an unresolvable place is reported rather than silently dropped', async () => {
  const sparse = new StaticGeocoder({ 'Sensoji Temple': jp('Sensoji Temple', 35.7148, 139.7967) })
  const result = await runPipeline('Day 1\nSensoji Temple\nNowhere At All', {
    ...offlineDeps(),
    geocoder: sparse,
  })
  assert.equal(result.reports.build.resolved, 1)
  assert.deepEqual(result.reports.build.unresolved.map((u) => u.query), ['Nowhere At All'])
})

test('ambiguous matches are flagged for confirmation before enrichment', async () => {
  const ambiguous = new StaticGeocoder({
    Victoria: [
      { name: 'Victoria', coords: { lat: 51.4952, lon: -0.1441 }, label: 'London' },
      { name: 'Victoria', coords: { lat: 48.4284, lon: -123.3656 }, label: 'British Columbia' },
    ],
  })
  const result = await runPipeline('Day 1\nVictoria', { ...offlineDeps(), geocoder: ambiguous })
  assert.equal(result.reports.build.needsConfirmation.length, 1)
  assert.equal(result.reports.build.needsConfirmation[0]?.alternatives[0]?.label, 'British Columbia')
})
