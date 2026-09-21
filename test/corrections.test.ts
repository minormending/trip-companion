import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EntityCache } from '../src/cache/entityCache.ts'
import { placeKey } from '../src/content/keys.ts'
import {
  SUPPRESSION_THRESHOLD,
  acceptCorrection,
  applyCorrections,
  entityKeyForCard,
  recordFlag,
  rejectCorrection,
} from '../src/corrections/loop.ts'
import { CorrectionStore } from '../src/corrections/store.ts'
import type { Card, Trip } from '../src/domain/types.ts'
import { leg, place, trip, SOURCE } from './helpers.ts'

const P1 = place('p1', 'Shinjuku Station', 35.6896, 139.7006, { region: 'jp' })
const P2 = place('p2', 'Tokyo Skytree', 35.7101, 139.8107, { region: 'jp' })

function payCard(): Card {
  return {
    id: 'card:how_to_pay:p1',
    attachesTo: { kind: 'place', placeId: 'p1' },
    kind: 'how_to_pay',
    title: 'Paying',
    body: 'Cards are accepted.',
    provenance: { tier: 'operational', sources: [SOURCE], verifiedAt: '2026-09-01', confidence: 0.9 },
  }
}

function sample(): Trip {
  return trip([P1, P2], [leg('l1', 'p1', 'p2', { mode: 'metro' })], [payCard()])
}

const flag = (t: Trip, store: CorrectionStore, claim: string, at: string, extra = {}) =>
  recordFlag(t, { cardId: 'card:how_to_pay:p1', claim, now: new Date(at), id: `fix-${at}`, ...extra }, store)

test('a flag is recorded against the place, not the trip', () => {
  const store = new CorrectionStore()
  const result = flag(sample(), store, 'The machine was coins only', '2026-09-20T10:00:00Z')

  assert.ok(result)
  assert.equal(result.correction.entityKey, placeKey(P1))
  assert.ok(!result.correction.entityKey.includes('trip'), 'nothing trip-specific in the key')
  assert.equal(result.correction.claim, 'The machine was coins only')
  assert.equal(result.correction.sawBody, 'Cards are accepted.', 'review can see what they saw')
  assert.equal(result.correction.status, 'open')
})

test('one flag lowers confidence but does not withdraw the card', () => {
  const store = new CorrectionStore()
  const t = sample()
  const result = flag(t, store, 'Wrong', '2026-09-20T10:00:00Z')

  assert.equal(result?.suppressed, false)
  assert.equal(applyCorrections(t, store).suppressed.length, 0)
  assert.ok(applyCorrections(t, store).trip.cards.length === 1, 'still shown')
})

test('two independent flags withdraw it pending review', () => {
  const store = new CorrectionStore()
  const t = sample()
  flag(t, store, 'Coins only', '2026-09-20T10:00:00Z')
  const second = flag(t, store, 'No card reader', '2026-09-21T11:00:00Z')

  assert.equal(second?.openFlags, SUPPRESSION_THRESHOLD)
  assert.equal(second?.suppressed, true)

  const applied = applyCorrections(t, store)
  assert.deepEqual(applied.suppressed, ['card:how_to_pay:p1'])
  assert.equal(applied.trip.cards.length, 0, 'a doubted operational card is not shown as fact')
})

test('one flag with evidence settles it alone', () => {
  const store = new CorrectionStore()
  const t = sample()
  const result = flag(t, store, 'Photo of the machine', '2026-09-20T10:00:00Z', { hasEvidence: true })
  assert.equal(result?.suppressed, true)
})

test('flagging lowers cached confidence and never raises it', async () => {
  const cache = await EntityCache.open()
  const key = placeKey(P1)
  cache.set(key, 'how_to_pay', {
    draft: { title: 'Paying', body: 'Cards are accepted.', sources: [SOURCE] },
    provenance: { tier: 'operational', sources: [SOURCE], verifiedAt: '2026-09-01', confidence: 0.9 },
  })
  const store = new CorrectionStore()
  const t = sample()
  recordFlag(t, { cardId: 'card:how_to_pay:p1', claim: 'wrong', now: new Date() }, store, cache)

  const after = cache.get(key, 'how_to_pay')?.provenance.confidence ?? 1
  assert.ok(after < 0.9, `confidence fell to ${after}`)
})

test('an accepted correction replaces the card for every later trip', async () => {
  const store = new CorrectionStore()
  const cache = await EntityCache.open()
  const t = sample()
  const first = flag(t, store, 'Coins only', '2026-09-20T10:00:00Z')
  assert.ok(first)

  assert.equal(acceptCorrection(store, cache, first.correction.id, 'Coins only. No card reader.'), true)

  // A different traveller, a fresh trip through the same station.
  const later = applyCorrections(sample(), store)
  assert.deepEqual(later.corrected, ['card:how_to_pay:p1'])
  assert.equal(later.trip.cards[0]?.body, 'Coins only. No card reader.')
  assert.ok((later.trip.cards[0]?.provenance.confidence ?? 0) >= 0.95, 'someone who was there outranks a tag')
})

test('accepting un-withdraws the card rather than leaving it hidden', () => {
  const store = new CorrectionStore()
  const t = sample()
  flag(t, store, 'a', '2026-09-20T10:00:00Z')
  const second = flag(t, store, 'b', '2026-09-21T10:00:00Z')
  assert.equal(applyCorrections(t, store).trip.cards.length, 0)

  acceptCorrection(store, undefined, second!.correction.id, 'Coins only.')
  const applied = applyCorrections(t, store)
  assert.equal(applied.trip.cards.length, 1, 'a reviewed card comes back')
  assert.equal(applied.trip.cards[0]?.body, 'Coins only.')
})

test('rejecting a flag restores the card', () => {
  const store = new CorrectionStore()
  const t = sample()
  const a = flag(t, store, 'a', '2026-09-20T10:00:00Z')
  const b = flag(t, store, 'b', '2026-09-21T10:00:00Z')
  assert.equal(applyCorrections(t, store).trip.cards.length, 0)

  assert.equal(rejectCorrection(store, a!.correction.id), true)
  assert.equal(rejectCorrection(store, b!.correction.id), true)
  assert.equal(applyCorrections(t, store).trip.cards.length, 1)
})

test('a correction cannot be resolved twice', () => {
  const store = new CorrectionStore()
  const result = flag(sample(), store, 'a', '2026-09-20T10:00:00Z')
  assert.equal(rejectCorrection(store, result!.correction.id), true)
  assert.equal(rejectCorrection(store, result!.correction.id), false)
  assert.equal(acceptCorrection(store, undefined, result!.correction.id, 'x'), false)
})

test('flagging an unknown card is refused rather than silently recorded', () => {
  const store = new CorrectionStore()
  assert.equal(recordFlag(sample(), { cardId: 'nope', claim: 'x' }, store), null)
  assert.equal(store.size, 0)
})

test('a leg card resolves to its leg entity, which survives the trip', () => {
  const legCard: Card = {
    id: 'card:boarding:l1',
    attachesTo: { kind: 'leg', legId: 'l1' },
    kind: 'boarding',
    title: 'Boarding',
    body: 'Rear door.',
    provenance: { tier: 'operational', sources: [SOURCE], verifiedAt: '2026-09-01', confidence: 0.9 },
  }
  const t = trip([P1, P2], [leg('l1', 'p1', 'p2', { mode: 'metro' })], [legCard])
  const key = entityKeyForCard(t, legCard)

  assert.ok(key?.startsWith('leg:metro:'))
  assert.ok(key?.includes('shinjuku-station'))
  assert.ok(!key?.includes('trip:'))
})

test('corrections survive a restart', async () => {
  let saved: Record<string, unknown> = {}
  const persistence = {
    async load() {
      return saved as never
    },
    async save(snapshot: Record<string, unknown>) {
      saved = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
    },
  }
  const store = await CorrectionStore.open(persistence)
  flag(sample(), store, 'Coins only', '2026-09-20T10:00:00Z')
  await store.flush()

  const reopened = await CorrectionStore.open(persistence)
  assert.equal(reopened.size, 1)
  assert.equal(reopened.all()[0]?.claim, 'Coins only')
})
