import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageInDays, isStale, missingLegs, orderedLegs, staleCards } from '../src/domain/graph.ts'
import type { Card, Tier } from '../src/domain/types.ts'
import { leg, place, trip } from './helpers.ts'

const NOW = new Date('2026-09-20T00:00:00Z')

function card(id: string, tier: Tier, verifiedAt: string): Card {
  return {
    id,
    attachesTo: { kind: 'place', placeId: 'p1' },
    kind: tier === 'colour' ? 'history' : 'how_to_pay',
    title: 't',
    body: 'b',
    provenance: { tier, sources: [], verifiedAt, confidence: 0.8 },
  }
}

test('missingLegs finds every consecutive pair with no leg', () => {
  const t = trip([place('p1', 'A', 0, 0), place('p2', 'B', 0, 1), place('p3', 'C', 0, 2)])
  assert.equal(missingLegs(t).length, 2)
})

test('missingLegs skips pairs already joined', () => {
  const t = trip(
    [place('p1', 'A', 0, 0), place('p2', 'B', 0, 1), place('p3', 'C', 0, 2)],
    [leg('l1', 'p1', 'p2')],
  )
  const gaps = missingLegs(t)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]?.from.id, 'p2')
})

test('orderedLegs drops legs pointing at places that do not exist', () => {
  const t = trip([place('p1', 'A', 0, 0)], [leg('l1', 'p1', 'ghost')])
  assert.equal(orderedLegs(t).length, 0)
})

test('operational cards go stale after ninety days', () => {
  assert.equal(isStale(card('c1', 'operational', '2026-08-01'), NOW), false)
  assert.equal(isStale(card('c2', 'operational', '2026-05-01'), NOW), true)
})

test('colour cards never go stale', () => {
  assert.equal(isStale(card('c3', 'colour', '2019-01-01'), NOW), false)
})

test('safety cards go stale fastest', () => {
  assert.equal(isStale(card('c4', 'safety', '2026-08-01'), NOW), true)
  assert.equal(isStale(card('c5', 'safety', '2026-09-10'), NOW), false)
})

test('staleCards can be narrowed to the tiers that strand people', () => {
  const t = trip(
    [place('p1', 'A', 0, 0)],
    [],
    [card('c1', 'operational', '2026-01-01'), card('c2', 'practical', '2026-01-01')],
  )
  assert.equal(staleCards(t, { now: NOW }).length, 2)
  assert.equal(staleCards(t, { tiers: ['operational'], now: NOW }).length, 1)
})

test('an unparseable verification date counts as infinitely old', () => {
  assert.equal(ageInDays('not-a-date', NOW), Number.POSITIVE_INFINITY)
  assert.equal(isStale(card('c6', 'operational', 'not-a-date'), NOW), true)
})
