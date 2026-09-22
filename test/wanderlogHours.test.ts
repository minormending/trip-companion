import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hoursByName, WanderlogProvider } from '../src/content/providers/wanderlog.ts'
import type { CardRequest } from '../src/content/providers/types.ts'

const PRAGUE = JSON.parse(
  readFileSync(new URL('./fixtures/wanderlog-prague.json', import.meta.url), 'utf8'),
)
const SOURCE = {
  url: 'https://wanderlog.com/api/tripPlans/aqifgcpkvo?clientSchemaVersion=2',
  title: 'Wanderlog: Trip to Prague',
  retrieved: '2026-09-21',
}

const ask = (name: string, kind = 'hours'): CardRequest =>
  ({
    kind,
    entityKey: `place:${name}`,
    context: { subject: 'place', place: { id: 'p', name, coords: { lat: 0, lon: 0 } } },
  }) as CardRequest

test('hours are read out of the document the traveller curated', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  const card = await provider.draft(ask('St. Vitus Cathedral'))

  assert.ok(card, 'the cathedral states its hours')
  // Google separates the number from AM/PM with U+202F, a narrow no-break
  // space, not an ordinary one. Pinned rather than normalised: anything that
  // later matches or splits these lines needs to know, and a test that quietly
  // typed a plain space would have hidden it.
  assert.match(card.body, /^Monday: 9\u202FAM\u20135\u202FPM$/m)
  // Sunday differs, which is exactly the kind of thing a summary would lose.
  assert.match(card.body, /^Sunday: 12\u20135\u202FPM$/m)
  assert.deepEqual(card.sources, [SOURCE])
})

test('the schedule is quoted, never summarised', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  const card = await provider.draft(ask('National Gallery Prague - Convent of St. Agnes'))
  assert.ok(card)

  // Seven lines, Monday first, closure intact. A card that rendered this as
  // "10 AM–6 PM" would be wrong on the one day it matters.
  assert.equal(card.body.split('\n').length, 7)
  assert.match(card.body, /^Monday: Closed/)
})

test('a place that states no hours yields nothing rather than a guess', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  // The State Opera is in the trip and records no hours; a venue that sells
  // tickets by performance has none to record.
  assert.equal(await provider.draft(ask('State Opera')), null)
  assert.equal(await provider.draft(ask('Not In This Trip At All')), null)
})

test('a place open around the clock says so, rather than saying nothing', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  const card = await provider.draft(ask('Charles Bridge'))
  // "Open 24 hours" is a fact worth carrying: it is the difference between a
  // place with no hours on file and one that never closes.
  assert.match(card?.body ?? '', /^Monday: Open 24 hours$/m)
})

test('the provider answers only for hours, and only for places', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  assert.equal(await provider.draft(ask('St. Vitus Cathedral', 'history')), null)
  assert.equal(await provider.draft(ask('St. Vitus Cathedral', 'how_to_pay')), null)
})

test('the real document supplies hours for most of the trip', () => {
  const found = hoursByName(PRAGUE)
  // Measured, not asserted from the docs: this is the supply the operational
  // tier was missing when the validation run produced zero operational cards.
  assert.ok(found.size >= 50, `expected a useful number of places, got ${found.size}`)
  assert.ok(found.get('U Fleků')?.weekdayText.length === 7)
})

test('an unrecognisable document is empty rather than an error', () => {
  assert.equal(hoursByName(null).size, 0)
  assert.equal(hoursByName({ nothing: 'useful' }).size, 0)
  assert.equal(hoursByName([]).size, 0)
})
