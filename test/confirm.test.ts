import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyChoices } from '../src/import/build.ts'
import { StaticGeocoder, type GeocodeCandidate } from '../src/geo/geocode.ts'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import { enrichTrip, resolveTrip, type PipelineDeps } from '../src/pipeline.ts'
import { NullTransitProvider } from '../src/routing/transit.ts'

const SHRINE: GeocodeCandidate = {
  name: 'Meiji Jingu Main Shrine',
  coords: { lat: 35.6748, lon: 139.6996 },
  countryCode: 'jp',
  label: 'Shibuya',
}
const STADIUM: GeocodeCandidate = {
  name: 'Meiji Jingu Stadium',
  coords: { lat: 35.6745, lon: 139.7172 },
  countryCode: 'jp',
  label: 'Shinjuku',
}

const GEO = new StaticGeocoder({
  // Deliberately stadium-first, which is what Photon actually returns.
  'Meiji Jingu': [STADIUM, SHRINE],
  'Yoyogi Park': [{ name: 'Yoyogi Park', coords: { lat: 35.6714, lon: 139.6952 }, countryCode: 'jp' }],
})

function offline(): PipelineDeps {
  return {
    geocoder: GEO,
    routers: [new NullTransitProvider()],
    providers: [new DeterministicProvider()],
  }
}

const ITINERARY = 'Day 1\nMeiji Jingu\nYoyogi Park'

test('resolve stops before enrichment and reports what needs confirming', async () => {
  const resolved = await resolveTrip(ITINERARY, offline())

  assert.equal(resolved.pending.length, 1)
  assert.equal(resolved.pending[0]?.query, 'Meiji Jingu')
  assert.equal(resolved.pending[0]?.chosen.name, 'Meiji Jingu Stadium')
  assert.equal(resolved.pending[0]?.alternatives[0]?.name, 'Meiji Jingu Main Shrine')

  // Nothing has been routed or written yet, so nothing was spent on the
  // stadium before the traveller got a say.
  assert.equal(resolved.trip.legs.length, 0)
  assert.equal(resolved.trip.cards.length, 0)
})

test('an unambiguous place produces no confirmation', async () => {
  const resolved = await resolveTrip('Day 1\nYoyogi Park', offline())
  assert.equal(resolved.pending.length, 0)
})

test('applying a choice moves the place to the chosen coordinates', async () => {
  const resolved = await resolveTrip(ITINERARY, offline())
  const pending = resolved.pending[0]
  assert.ok(pending)

  const before = resolved.trip.places.find((p) => p.id === pending.placeId)
  assert.equal(before?.coords.lon, STADIUM.coords.lon)

  const corrected = applyChoices(resolved.trip, [
    { placeId: pending.placeId, candidate: SHRINE },
  ])
  const after = corrected.places.find((p) => p.id === pending.placeId)
  assert.equal(after?.coords.lon, SHRINE.coords.lon)
  assert.equal(after?.name, 'Meiji Jingu', 'the traveller\'s own wording is kept')
})

test('applying a choice carries the region and timezone across', async () => {
  const resolved = await resolveTrip(ITINERARY, offline())
  const pending = resolved.pending[0]!
  const corrected = applyChoices(resolved.trip, [{ placeId: pending.placeId, candidate: SHRINE }])
  const place = corrected.places.find((p) => p.id === pending.placeId)
  assert.equal(place?.region, 'jp')
  assert.equal(place?.timezone, 'Asia/Tokyo')
})

test('confirming changes the routing that follows', async () => {
  const resolved = await resolveTrip(ITINERARY, offline())
  const pending = resolved.pending[0]!

  const asIs = await enrichTrip(resolved.trip, offline(), resolved.report)
  const confirmed = await enrichTrip(
    applyChoices(resolved.trip, [{ placeId: pending.placeId, candidate: SHRINE }]),
    offline(),
    resolved.report,
  )

  const stadiumLeg = asIs.trip.legs[0]
  const shrineLeg = confirmed.trip.legs[0]
  assert.ok(stadiumLeg && shrineLeg)
  // The stadium is ~2km from Yoyogi Park; the shrine is a few hundred metres.
  assert.ok(
    (stadiumLeg.distanceMetres ?? 0) > (shrineLeg.distanceMetres ?? 0) * 2,
    `stadium ${stadiumLeg.distanceMetres}m vs shrine ${shrineLeg.distanceMetres}m`,
  )
  assert.equal(shrineLeg.mode, 'walk', 'the right building is walkable')
  assert.equal(stadiumLeg.mode, 'transit', 'the wrong one is not')
})

test('applying no choices leaves the trip untouched', async () => {
  const resolved = await resolveTrip(ITINERARY, offline())
  assert.equal(applyChoices(resolved.trip, []), resolved.trip)
})
