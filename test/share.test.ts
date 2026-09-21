import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeTrip, encodeTrip } from '../web/share.ts'
import type { Trip } from '../src/domain/types.ts'
import { leg, place, trip, SOURCE } from './helpers.ts'

const SAMPLE: Trip = {
  ...trip(
    [
      place('p1', 'Sensoji Temple', 35.7148, 139.7967, { timezone: 'Asia/Tokyo', region: 'jp' }),
      place('p2', 'Tokyo Skytree', 35.7101, 139.8107, { dayIndex: 2 }),
    ],
    [leg('l1', 'p1', 'p2', { mode: 'walk', durationMinutes: 12, distanceMetres: 980 })],
    [
      {
        id: 'card:how_to_pay:l1',
        attachesTo: { kind: 'leg', legId: 'l1' },
        kind: 'how_to_pay',
        title: 'Paying',
        body: 'Exact change only.',
        provenance: { tier: 'operational', sources: [SOURCE], verifiedAt: '2026-09-15', confidence: 0.9 },
      },
    ],
  ),
  departsOn: '2026-11-03',
}

test('a trip survives the share round trip intact', async () => {
  const decoded = await decodeTrip(await encodeTrip(SAMPLE))
  assert.deepEqual(decoded, SAMPLE)
})

test('the encoded form is URL-fragment safe', async () => {
  const encoded = await encodeTrip(SAMPLE)
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'base64url only, no padding or reserved characters')
})

test('compression keeps a realistic trip inside a usable URL', async () => {
  const big: Trip = {
    ...SAMPLE,
    places: Array.from({ length: 25 }, (_, i) =>
      place(`p${i}`, `Place number ${i}`, 35.7 + i * 0.001, 139.8 + i * 0.001, { region: 'jp' }),
    ),
  }
  const encoded = await encodeTrip(big)
  assert.ok(encoded.length < 8000, `25-stop trip encodes to ${encoded.length} chars`)
})

test('a corrupt fragment decodes to null rather than throwing', async () => {
  assert.equal(await decodeTrip('not-valid-gzip'), null)
  assert.equal(await decodeTrip(''), null)
})
