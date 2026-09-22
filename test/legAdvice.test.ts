import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import { checkVoice } from '../src/content/voice.ts'
import { TIER_PERSONALITY, CARD_TIER, type Leg, type Place } from '../src/domain/types.ts'
import type { CardRequest } from '../src/content/providers/types.ts'

const from: Place = { id: 'a', name: 'Bistró Loreta', coords: { lat: 50.088, lon: 14.391 } }
const to: Place = { id: 'b', name: 'Vinotéka U Lachtana', coords: { lat: 50.076, lon: 14.442 } }

const ask = (leg: Partial<Leg>): CardRequest =>
  ({
    kind: 'watch_for',
    entityKey: 'leg:a>b',
    context: {
      subject: 'leg',
      leg: { id: 'l', fromPlaceId: 'a', toPlaceId: 'b', mode: 'walk', inferred: false, ...leg },
      from,
      to,
      mode: leg.mode ?? 'walk',
    },
  }) as CardRequest

const provider = new DeterministicProvider()

test('a routed walk gets no card of its own', async () => {
  // The briefing already prints "Walk, 12 min, 900 m" beside the leg. "On
  // foot the whole way" under it is the same fact in a box.
  for (const durationMinutes of [2, 5, 12, 22, 29]) {
    assert.equal(await provider.draft(ask({ durationMinutes })), null, `${durationMinutes} min`)
  }
})

test('a long walk is named as one, with its length', async () => {
  const card = await provider.draft(ask({ durationMinutes: 64, distanceMetres: 4800 }))
  assert.ok(card)
  assert.match(card.body, /About 64 minutes on foot/)
  assert.match(card.body, /local transport/)
  assert.doesNotMatch(card.body, /Follow the street network/)
})

test('a leg no router served says its distance is a straight line', async () => {
  const card = await provider.draft(ask({ mode: 'flight', inferred: true }))
  assert.ok(card)
  assert.match(card.body, /Air leg/)
  assert.match(card.body, /straight line and the time is not established/)
})

test('a trivial walk that no router served still gets a card', async () => {
  // Two minutes is only known to be two minutes when something measured it.
  const card = await provider.draft(ask({ durationMinutes: 2, inferred: true }))
  assert.ok(card, 'an unmeasured leg is not a trivial one')
  assert.match(card.body, /straight line/)
})

test('every shape it produces passes the voice check for its tier', async () => {
  const personality = TIER_PERSONALITY[CARD_TIER['watch_for']]
  const shapes: Array<Partial<Leg>> = [
    { durationMinutes: 12 },
    { durationMinutes: 64 },
    { mode: 'flight', inferred: true },
    { mode: 'transit', inferred: true },
    { mode: 'ferry', durationMinutes: 20 },
    { durationMinutes: 40, inferred: true },
  ]
  for (const shape of shapes) {
    const card = await provider.draft(ask(shape))
    if (!card) continue
    const violations = checkVoice(card.body, personality)
    assert.deepEqual(violations, [], `${JSON.stringify(shape)} -> ${card.body}`)
  }
})
