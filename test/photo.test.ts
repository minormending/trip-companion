import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrivalOn, nearestWindow, photoCard } from '../src/content/photo.ts'
import { goldenHours } from '../src/content/sun.ts'
import type { Place } from '../src/domain/types.ts'

/** Antonínovo pekařství: the bakery the traveller reaches at 07:45. */
const BAKERY: Place = {
  id: 'p:bakery',
  name: 'Antonínovo pekařství',
  coords: { lat: 50.0749053, lon: 14.4377229 },
  timezone: 'Europe/Prague',
  region: 'cz',
  arrive: '07:45',
}
const OCT_16 = new Date('2026-10-16T00:00:00Z')

test('the card speaks to the hour the traveller is there', () => {
  const card = photoCard(BAKERY, OCT_16)
  assert.ok(card)

  // The complaint this fixes: a 07:45 bakery was told about 17:32-18:32 with
  // no hint that the light is nine hours after they have gone.
  assert.match(card.body, /before you arrive|after you arrive|when you arrive/)
})

test('a morning visit is pointed at the morning window', () => {
  const card = photoCard(BAKERY, OCT_16)
  assert.ok(card)
  const [hh] = /(\d{2}):(\d{2})/.exec(card.body)?.slice(1) ?? []
  assert.ok(Number(hh) < 12, `expected a morning window, card said: ${card.body}`)
})

test('an evening visit is pointed at the evening window', () => {
  const card = photoCard({ ...BAKERY, arrive: '18:00' }, OCT_16)
  assert.ok(card)
  const [hh] = /(\d{2}):(\d{2})/.exec(card.body)?.slice(1) ?? []
  assert.ok(Number(hh) >= 12, `expected an evening window, card said: ${card.body}`)
})

test('with no arrival time the evening window is still the guess', () => {
  const { arrive, ...noTime } = BAKERY
  const card = photoCard(noTime as Place, OCT_16)
  assert.ok(card)
  assert.match(card.body, /^Low warm light \d{2}:\d{2}–\d{2}:\d{2}\.$/)
})

test('an arrival inside the window says so rather than measuring a gap', () => {
  const golden = goldenHours(OCT_16, BAKERY.coords)
  const morning = golden[0]
  assert.ok(morning)
  // Land exactly in the middle of the real window.
  const mid = new Date((morning.start.getTime() + morning.end.getTime()) / 2)
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Prague',
  }).format(mid)

  const card = photoCard({ ...BAKERY, arrive: hhmm }, OCT_16)
  assert.ok(card)
  assert.match(card.body, /which is when you arrive/)
})

test('arrival is read in the place’s own zone, not the machine’s', () => {
  const at = arrivalOn(OCT_16, BAKERY)
  assert.ok(at)
  // 07:45 in Prague on 16 October is 05:45 UTC — CEST, two hours ahead.
  assert.equal(at.toISOString(), '2026-10-16T05:45:00.000Z')
})

test('without a zone the longitude estimate is used, consistently', () => {
  const { timezone, ...noZone } = BAKERY
  const at = arrivalOn(OCT_16, noZone as Place)
  assert.ok(at)
  // 14.44°E rounds to one hour east, so 07:45 local is 06:45 UTC. Coarser
  // than the real zone by an hour, and the card says the times are estimates.
  assert.equal(at.toISOString(), '2026-10-16T06:45:00.000Z')
})

test('an unusable arrival time is ignored rather than guessed at', () => {
  for (const arrive of ['', 'lunchtime', '25:00', '12:60', '7.45']) {
    assert.equal(arrivalOn(OCT_16, { ...BAKERY, arrive }), undefined, arrive)
  }
})

test('nearestWindow picks by proximity and prefers containment', () => {
  const w = (a: string, b: string) => ({ start: new Date(a), end: new Date(b) })
  const morning = w('2026-10-16T04:30:00Z', '2026-10-16T05:30:00Z')
  const evening = w('2026-10-16T15:30:00Z', '2026-10-16T16:30:00Z')

  assert.equal(nearestWindow([morning, evening], new Date('2026-10-16T05:45:00Z')), morning)
  assert.equal(nearestWindow([morning, evening], new Date('2026-10-16T14:00:00Z')), evening)
  assert.equal(nearestWindow([morning, evening], new Date('2026-10-16T05:00:00Z')), morning)
  // No arrival at all falls back to the evening, which is what people plan for.
  assert.equal(nearestWindow([morning, evening], undefined), evening)
  assert.equal(nearestWindow([], new Date()), undefined)
})
