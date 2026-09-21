import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coordsFrom, noteText, tripFromWanderlog, wanderlogKey } from '../src/import/wanderlog.ts'

/** Shaped from the CLI's documented types: sections carry displayHeading, and
 *  places are Google Places objects stored verbatim. */
const DOC = {
  key: 'abc123xyz',
  title: 'Tokyo in autumn',
  startDate: '2026-11-03T00:00:00Z',
  itinerary: {
    sections: [
      {
        id: 391150968,
        displayHeading: 'Tuesday, November 3rd',
        type: 'normal',
        blocks: [
          {
            startTime: '09:00',
            text: { ops: [{ insert: 'go at sunrise to beat the crowds\n' }] },
            place: {
              place_id: 'ChIJ8T1GpMGOGGARDYGSgpooDWw',
              name: 'Sensō-ji',
              geometry: { location: { lat: 35.7147651, lng: 139.7966553 } },
              formatted_address: '2 Chome-3-1 Asakusa, Taito City, Tokyo, Japan',
              address_components: [{ types: ['country'], short_name: 'JP', long_name: 'Japan' }],
            },
          },
          {
            place: {
              place_id: 'ChIJ35ov0dCOGGARKvdDH7NPHX0',
              name: 'Tokyo Skytree',
              geometry: { location: { lat: 35.7100627, lng: 139.8107004 } },
              address_components: [{ types: ['country'], short_name: 'JP', long_name: 'Japan' }],
            },
          },
        ],
      },
      {
        id: 391150969,
        displayHeading: 'Places to visit',
        type: 'unscheduled',
        blocks: [
          {
            place: {
              name: 'Nishiki Market',
              geometry: { location: { lat: 35.0050, lng: 135.7649 } },
            },
          },
        ],
      },
    ],
  },
}

test('a Wanderlog document becomes a trip with no geocoding at all', () => {
  const { trip, report } = tripFromWanderlog(DOC)

  assert.equal(report.places, 2)
  assert.equal(trip.places.length, 2)
  assert.equal(trip.places[0]?.name, 'Sensō-ji')
  // The coordinates come from the itinerary the traveller already curated, so
  // there is nothing to disambiguate and no wrong building to pick.
  assert.deepEqual(trip.places[0]?.coords, { lat: 35.7147651, lon: 139.7966553 })
})

test('country and timezone are derived from the place, not looked up', () => {
  const { trip } = tripFromWanderlog(DOC)
  assert.equal(trip.places[0]?.region, 'jp')
  assert.equal(trip.places[0]?.timezone, 'Asia/Tokyo')
})

test('standing buckets are not treated as days', () => {
  const { trip } = tripFromWanderlog(DOC)
  const names = trip.places.map((p) => p.name)
  assert.ok(!names.includes('Nishiki Market'), '"Places to visit" is not a day')
  assert.ok(trip.places.every((p) => p.dayIndex === 1))
})

test('times are normalised and carried across', () => {
  const { trip } = tripFromWanderlog(DOC)
  assert.equal(trip.places[0]?.arrive, '09:00')
  assert.equal(trip.places[1]?.arrive, undefined)
})

test('the title and departure date come from the document', () => {
  const { trip } = tripFromWanderlog(DOC)
  assert.equal(trip.title, 'Tokyo in autumn')
  assert.equal(trip.departsOn, '2026-11-03')
})

test('an explicit title overrides the document', () => {
  assert.equal(tripFromWanderlog(DOC, { title: 'Mine' }).trip.title, 'Mine')
})

test('the trip key is found for re-sync', () => {
  assert.equal(wanderlogKey(DOC), 'abc123xyz')
  assert.equal(wanderlogKey({ data: DOC }), 'abc123xyz')
  assert.equal(wanderlogKey({}), undefined)
})

test('a response wrapped in data is unwrapped', () => {
  assert.equal(tripFromWanderlog({ data: DOC }).report.places, 2)
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

test('a place with no usable coordinates is skipped, not invented', () => {
  const doc = {
    itinerary: {
      sections: [
        {
          displayHeading: 'Day 1',
          type: 'normal',
          blocks: [
            { place: { name: 'Nowhere' } },
            { place: { name: 'Somewhere', geometry: { location: { lat: 1, lng: 2 } } } },
          ],
        },
      ],
    },
  }
  const { trip } = tripFromWanderlog(doc)
  assert.equal(trip.places.length, 1)
  assert.equal(trip.places[0]?.name, 'Somewhere')
})

test('an unrecognisable document yields an empty trip rather than throwing', () => {
  assert.equal(tripFromWanderlog({ nothing: 'useful' }).trip.places.length, 0)
  assert.equal(tripFromWanderlog(null).trip.places.length, 0)
  assert.equal(tripFromWanderlog([]).trip.places.length, 0)
})

test('nesting the walk does not reach into an unrelated section', () => {
  const doc = {
    itinerary: {
      sections: [
        {
          displayHeading: 'Day 1',
          type: 'normal',
          blocks: [{ place: { name: 'A', geometry: { location: { lat: 1, lng: 1 } } } }],
        },
        {
          displayHeading: 'Day 2',
          type: 'normal',
          blocks: [{ place: { name: 'B', geometry: { location: { lat: 2, lng: 2 } } } }],
        },
      ],
    },
  }
  const { trip } = tripFromWanderlog(doc)
  assert.deepEqual(trip.places.map((p) => [p.name, p.dayIndex]), [
    ['A', 1],
    ['B', 2],
  ])
})
