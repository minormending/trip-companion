import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { coordsFrom, noteText, tripFromWanderlog, wanderlogKey } from '../src/import/wanderlog.ts'

/**
 * A verbatim excerpt of a real trip, fetched from
 * /api/tripPlans/<key>?clientSchemaVersion=2 while signed in.
 *
 * Nothing about its shape is edited: photo blobs, review text and image keys
 * are removed for size, every remaining key and value is exactly as Wanderlog
 * served it. That matters more than it sounds. The fixture this replaced was
 * written from the CLI's documented types and got both load-bearing field
 * names wrong — `displayHeading` for `heading`, `data` for `tripPlan` — so the
 * whole suite passed against an importer that returned zero places from any
 * real document. A fixture invented from the same source as the code under
 * test only proves the two agree.
 */
const PRAGUE = JSON.parse(
  readFileSync(new URL('./fixtures/wanderlog-prague.json', import.meta.url), 'utf8'),
)

test('a real Wanderlog document yields its places with no geocoding at all', () => {
  const { trip, report } = tripFromWanderlog(PRAGUE)

  assert.equal(report.sections, 14)
  assert.equal(report.places, 101)
  assert.equal(trip.places.length, 101)
  assert.deepEqual(report.skipped, [])

  // The coordinates come from the itinerary the traveller already curated, so
  // there is nothing to disambiguate and no wrong building to pick.
  const castle = trip.places.find((p) => p.name === 'St. Vitus Cathedral')
  assert.deepEqual(castle?.coords, { lat: 50.090891799999994, lon: 14.4005114 })
})

test('the payload is found under tripPlan, where the trip route puts it', () => {
  const { trip } = tripFromWanderlog(PRAGUE)
  assert.equal(trip.title, 'Trip to Prague')
  assert.equal(trip.departsOn, '2026-10-14')
  assert.equal(wanderlogKey(PRAGUE), 'yhnizmwsthhmdhdj')
})

test('days are the dayPlan sections, in date order', () => {
  const { trip } = tripFromWanderlog(PRAGUE)
  const byDay = (d: number) => trip.places.filter((p) => p.dayIndex === d)

  assert.deepEqual(
    [1, 2, 3, 4, 5].map((d) => byDay(d).length),
    [1, 14, 9, 6, 3],
  )
  assert.equal(byDay(1)[0]?.name, 'John F. Kennedy International Airport')
  assert.equal(byDay(2)[0]?.name, 'Václav Havel Airport Prague')
  assert.equal(byDay(5).at(-1)?.name, 'Václav Havel Airport Prague')
  assert.equal(trip.places.some((p) => (p.dayIndex ?? 0) > 5), false)
})

test('standing buckets keep their places but take no day', () => {
  const { trip, report } = tripFromWanderlog(PRAGUE)

  // `type` cannot tell a day from a bucket here: eleven sections say "normal"
  // and only five are days. Several bucket entries are notes about places that
  // were deliberately *dropped* from the itinerary, so putting them on a day
  // would stage thirty rejected candidates ahead of the real trip.
  assert.equal(report.unscheduled, 68)
  const lane = trip.places.find((p) => p.name === 'Golden Lane')
  assert.ok(lane, 'a bucket place is still imported')
  assert.equal(lane?.dayIndex, undefined)
})

test('times are normalised and carried across', () => {
  const { trip } = tripFromWanderlog(PRAGUE)
  const opera = trip.places.find((p) => p.name === 'State Opera')
  assert.equal(opera?.arrive, '19:00')
  assert.equal(trip.places.find((p) => p.name === 'Charles Bridge')?.arrive, undefined)
})

test('country and timezone are derived from the place, not looked up', () => {
  const { trip } = tripFromWanderlog(PRAGUE)
  const clock = trip.places.find((p) => p.name === 'Prague Astronomical Clock')
  assert.equal(clock?.region, 'cz')
  assert.equal(clock?.timezone, 'Europe/Prague')
})

test('a country that disagrees with the trip is reported, never corrected', () => {
  const { report } = tripFromWanderlog(PRAGUE)
  const names = report.regionConflicts.map((c) => c.name)

  // Genuine: the trip leaves from New York.
  assert.ok(names.includes('John F. Kennedy International Airport'))
  // An upstream data error: Google tags this Prague garden US. Reported so a
  // human can see it, and left alone, because guessing which of the two kinds
  // this is would be inventing a fact about somebody's trip.
  assert.ok(names.includes('South Gardens of Prague Castle'))
  assert.ok(report.regionConflicts.every((c) => c.region === 'us'))
})

test('an explicit title overrides the document', () => {
  assert.equal(tripFromWanderlog(PRAGUE, { title: 'Mine' }).trip.title, 'Mine')
})

test('a response wrapped in data is unwrapped too', () => {
  const inner = (PRAGUE as { tripPlan: unknown }).tripPlan
  assert.equal(tripFromWanderlog({ data: inner }).report.places, 101)
  assert.equal(wanderlogKey({ data: inner }), 'yhnizmwsthhmdhdj')
  assert.equal(wanderlogKey({}), undefined)
})

test('Quill deltas and bare strings both yield note text', () => {
  assert.equal(noteText({ ops: [{ insert: 'coins only\n' }] }), 'coins only')
  assert.equal(noteText({ ops: [{ insert: 'a' }, { insert: 'b\n' }] }), 'ab')
  assert.equal(noteText('plain string'), 'plain string')
  assert.equal(noteText({ ops: [] }), undefined)
  assert.equal(noteText(undefined), undefined)
})

test('coordinates are read from Google geometry or a flattened pair', () => {
  assert.deepEqual(coordsFrom({ geometry: { location: { lat: 1, lng: 2 } } }), { lat: 1, lon: 2 })
  assert.deepEqual(coordsFrom({ latitude: 3, longitude: 4 }), { lat: 3, lon: 4 })
  assert.equal(coordsFrom({ name: 'no coords' }), undefined)
})

test('a place with no usable coordinates is named in the report, not invented', () => {
  const doc = {
    tripPlan: {
      itinerary: {
        sections: [
          {
            heading: 'Day 1',
            mode: 'dayPlan',
            date: '2026-01-01',
            blocks: [
              { place: { name: 'Nowhere' } },
              { place: { name: 'Somewhere', geometry: { location: { lat: 1, lng: 2 } } } },
            ],
          },
        ],
      },
    },
  }
  const { trip, report } = tripFromWanderlog(doc)
  assert.deepEqual(trip.places.map((p) => p.name), ['Somewhere'])
  assert.deepEqual(report.skipped, ['Nowhere'])
})

test('displayHeading still works, for whatever payload the CLI types describe', () => {
  const doc = {
    data: {
      title: 'Older shape',
      itinerary: {
        sections: [
          {
            displayHeading: 'Tuesday',
            type: 'normal',
            blocks: [{ place: { name: 'A', geometry: { location: { lat: 1, lng: 1 } } } }],
          },
        ],
      },
    },
  }
  const { trip } = tripFromWanderlog(doc)
  // No section says dayPlan, so every section is treated as a day, as before.
  assert.deepEqual(trip.places.map((p) => [p.name, p.dayIndex]), [['A', 1]])
})

test('an unrecognisable document yields an empty trip rather than throwing', () => {
  assert.equal(tripFromWanderlog({ nothing: 'useful' }).trip.places.length, 0)
  assert.equal(tripFromWanderlog(null).trip.places.length, 0)
  assert.equal(tripFromWanderlog([]).trip.places.length, 0)
})

test('the walk does not reach into an unrelated section', () => {
  const doc = {
    tripPlan: {
      itinerary: {
        sections: [
          { heading: 'Day 1', mode: 'dayPlan', blocks: [{ place: { name: 'A', geometry: { location: { lat: 1, lng: 1 } } } }] },
          { heading: 'Day 2', mode: 'dayPlan', blocks: [{ place: { name: 'B', geometry: { location: { lat: 2, lng: 2 } } } }] },
        ],
      },
    },
  }
  const { trip } = tripFromWanderlog(doc)
  assert.deepEqual(trip.places.map((p) => [p.name, p.dayIndex]), [
    ['A', 1],
    ['B', 2],
  ])
})
