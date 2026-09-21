import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkIn, computeNow, promoteForTravel, undoCheckIn } from '../src/companion/now.ts'
import type { Card, CardKind, Trip } from '../src/domain/types.ts'
import { leg, place, trip, SOURCE } from './helpers.ts'

function card(kind: CardKind, owner: Card['attachesTo']): Card {
  return {
    id: `card:${kind}:${owner.kind === 'place' ? owner.placeId : owner.legId}`,
    attachesTo: owner,
    kind,
    title: kind,
    body: `${kind} body`,
    provenance: { tier: 'operational', sources: [SOURCE], verifiedAt: '2026-09-21', confidence: 0.9 },
  }
}

const A = place('p1', 'Sensoji Temple', 35.7148, 139.7967)
const B = place('p2', 'Tokyo Skytree', 35.7101, 139.8107)
const C = place('p3', 'Shibuya Crossing', 35.6595, 139.7004)

function sample(): Trip {
  return trip(
    [A, B, C],
    [leg('l1', 'p1', 'p2', { mode: 'metro' }), leg('l2', 'p2', 'p3', { mode: 'rail' })],
    [
      card('history', { kind: 'place', placeId: 'p2' }),
      card('boarding', { kind: 'leg', legId: 'l1' }),
      card('photo', { kind: 'place', placeId: 'p2' }),
      card('caution', { kind: 'leg', legId: 'l1' }),
      card('history', { kind: 'place', placeId: 'p3' }),
    ],
  )
}

test('before any check-in, the next stop is the first one', () => {
  const now = computeNow(sample(), [])
  assert.equal(now.at, undefined)
  assert.equal(now.next?.id, 'p1')
  assert.equal(now.leg, undefined, 'no leg until the trip has started')
  assert.equal(now.reached, 0)
  assert.equal(now.total, 3)
  assert.equal(now.complete, false)
})

test('after checking in, the current leg is the one being travelled', () => {
  const now = computeNow(sample(), checkIn([], 'p1', new Date('2026-11-03T09:00:00Z')))
  assert.equal(now.at?.id, 'p1')
  assert.equal(now.next?.id, 'p2')
  assert.equal(now.leg?.id, 'l1')
  assert.equal(now.reached, 1)
})

test('the companion shows only the current leg and the stop ahead', () => {
  const now = computeNow(sample(), checkIn([], 'p1', new Date('2026-11-03T09:00:00Z')))
  const owners: string[] = now.cards.map((c) =>
    c.attachesTo.kind === 'place' ? c.attachesTo.placeId : c.attachesTo.legId,
  )
  // The `some` check comes first: asserting `every` narrows the array's element
  // type, and the later check would then be comparing against a narrowed union.
  assert.ok(!owners.some((o) => o === 'p3'), 'a later stop is not the companion’s business yet')
  assert.ok(owners.every((o) => o === 'l1' || o === 'p2'))
})

test('what can strand you is promoted above what is merely interesting', () => {
  const now = computeNow(sample(), checkIn([], 'p1', new Date('2026-11-03T09:00:00Z')))
  const kinds = now.cards.map((c) => c.kind)
  assert.equal(kinds[0], 'caution')
  assert.equal(kinds[1], 'boarding')
  assert.ok(kinds.indexOf('history') > kinds.indexOf('boarding'))
  assert.ok(kinds.indexOf('photo') > kinds.indexOf('boarding'))
})

test('promotion is stable for unknown kinds rather than dropping them', () => {
  const odd = { ...card('phrase', { kind: 'place', placeId: 'p2' }), kind: 'mystery' as CardKind }
  const ordered = promoteForTravel([odd, card('caution', { kind: 'place', placeId: 'p2' })])
  assert.equal(ordered.length, 2)
  assert.equal(ordered[0]?.kind, 'caution')
  assert.equal(ordered[1]?.kind, 'mystery')
})

test('the last check-in wins even when they arrive out of order', () => {
  const checkIns = [
    { placeId: 'p1', at: '2026-11-03T09:00:00Z' },
    { placeId: 'p2', at: '2026-11-03T11:00:00Z' },
  ]
  const now = computeNow(sample(), [checkIns[1]!, checkIns[0]!])
  assert.equal(now.at?.id, 'p2', 'ordered by time, not by array position')
  assert.equal(now.next?.id, 'p3')
  assert.equal(now.leg?.id, 'l2')
})

test('the trip reports complete once every stop is reached', () => {
  let checkIns = checkIn([], 'p1', new Date('2026-11-03T09:00:00Z'))
  checkIns = checkIn(checkIns, 'p2', new Date('2026-11-03T11:00:00Z'))
  checkIns = checkIn(checkIns, 'p3', new Date('2026-11-03T15:00:00Z'))

  const now = computeNow(sample(), checkIns)
  assert.equal(now.complete, true)
  assert.equal(now.next, undefined)
  assert.equal(now.reached, 3)
  assert.deepEqual(now.cards, [], 'nothing ahead, so nothing to show')
})

test('checking in twice does not double count', () => {
  const once = checkIn([], 'p1', new Date('2026-11-03T09:00:00Z'))
  const twice = checkIn(once, 'p1', new Date('2026-11-03T09:05:00Z'))
  assert.equal(twice.length, 1)
  assert.equal(twice[0]?.at, once[0]?.at, 'the original arrival time is kept')
})

test('a check-in can be undone', () => {
  const checkIns = checkIn([], 'p1', new Date('2026-11-03T09:00:00Z'))
  assert.deepEqual(undoCheckIn(checkIns, 'p1'), [])
  assert.equal(computeNow(sample(), undoCheckIn(checkIns, 'p1')).next?.id, 'p1')
})

test('a gap in the middle is treated as the next thing to reach', () => {
  // Checked into the first and third stops but not the second: the second is
  // still what is ahead, because it has not been reached.
  const checkIns = [
    { placeId: 'p1', at: '2026-11-03T09:00:00Z' },
    { placeId: 'p3', at: '2026-11-03T15:00:00Z' },
  ]
  const now = computeNow(sample(), checkIns)
  assert.equal(now.next?.id, 'p2')
  assert.equal(now.at?.id, 'p3', 'where they actually are')
  assert.equal(now.leg, undefined, 'no leg runs p3 to p2, and none is invented')
})
