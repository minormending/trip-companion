import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { costsByName, descriptionsByName, dominantCurrency, hoursByName, WanderlogProvider } from '../src/content/providers/wanderlog.ts'
import { checkVoice } from '../src/content/voice.ts'
import { CARD_TIER, TIER_PERSONALITY } from '../src/domain/types.ts'
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

test('the provider answers for hours, history and paying, and nothing else', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  assert.ok(await provider.draft(ask('St. Vitus Cathedral', 'hours')))
  assert.ok(await provider.draft(ask('St. Vitus Cathedral', 'history')))
  assert.ok(await provider.draft(ask('St. Vitus Cathedral', 'how_to_pay')))
  // Boarding and caution are about the world, and the document states neither.
  assert.equal(await provider.draft(ask('St. Vitus Cathedral', 'caution')), null)
  assert.equal(await provider.draft(ask('St. Vitus Cathedral', 'orientation')), null)
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

// ── descriptions ────────────────────────────────────────────────────────────

test('a place the document describes gets a history card', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  const card = await provider.draft(ask('Lokál U Bílé kuželky', 'history'))

  assert.ok(card, 'the document describes this pub; Wikipedia does not')
  assert.match(card.body, /lively pub/)
  assert.deepEqual(card.sources, [SOURCE])
  assert.equal(card.title, 'Lokál U Bílé kuželky')
})

test('a place the document does not describe gets nothing, not a placeholder', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  // Nobody has written anything verifiable about a banh mi counter, and the
  // briefing is better for saying so by omission.
  assert.equal(await provider.draft(ask('Mr. Banh Mi', 'history')), null)
})

test('generatedDescription is never used, however well it reads', async () => {
  // Shaped exactly as the document carries it: both fields on one entry.
  const doc = {
    resources: {
      placeMetadata: [
        {
          name: 'Somewhere',
          placeId: 'ChIJxxx',
          generatedDescription: 'Somewhere is a delightful spot beloved by locals and visitors alike.',
        },
      ],
    },
  }
  const provider = new WanderlogProvider(doc, SOURCE)
  assert.equal(provider.described, 0)
  assert.equal(await provider.draft(ask('Somewhere', 'history')), null)
})

test('only place metadata is read, not anything with a description', () => {
  // An object with a description but no placeId is not a place.
  const doc = { something: { name: 'Not a place', description: 'a blurb about a guide' } }
  assert.equal(descriptionsByName(doc).size, 0)
  assert.equal(descriptionsByName(null).size, 0)
})

test('the document describes a useful share of the trip', () => {
  const found = descriptionsByName(PRAGUE)
  assert.ok(found.size >= 40, `expected a useful number, got ${found.size}`)
})

// ── what the trip records paying ────────────────────────────────────────────

test('a place the budget prices gets a paying card', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  const card = await provider.draft(ask('State Opera', 'how_to_pay'))

  assert.ok(card)
  assert.equal(card.body, 'Recorded in the trip budget as 890 CZK.')
  assert.deepEqual(card.sources, [SOURCE])
})

test('a cost in another currency says which one the trip uses', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  // The traveller recorded the cathedral in dollars and everything else in
  // koruna. They will not be charged in dollars.
  const card = await provider.draft(ask('St. Vitus Cathedral', 'how_to_pay'))
  assert.ok(card)
  assert.match(card.body, /22 USD/)
  assert.match(card.body, /The rest of this trip is budgeted in CZK/)
})

test('the same amount recorded twice is said once', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  // Two visits to the bakery, 200 CZK each. "200 CZK and 200 CZK" is worse
  // than useless.
  const card = await provider.draft(ask('Antonínovo pekařství', 'how_to_pay'))
  assert.ok(card)
  assert.equal(card.body, 'Recorded in the trip budget as 200 CZK.')
})

test('a place with nothing budgeted gets no paying card', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  assert.equal(await provider.draft(ask('Charles Bridge', 'how_to_pay')), null)
})

test('expenses are joined by blockId, not by matching a description', () => {
  const costs = costsByName(PRAGUE)
  assert.equal(costs.size, 13)
  assert.deepEqual(costs.get('State Opera'), [{ amount: 890, currency: 'CZK' }])
  assert.equal(dominantCurrency(costs), 'CZK')
})

test('a budget with no clear currency claims none', () => {
  const costs = new Map([
    ['A', [{ amount: 10, currency: 'EUR' }]],
    ['B', [{ amount: 10, currency: 'GBP' }]],
  ])
  assert.equal(dominantCurrency(costs), undefined)
  assert.equal(dominantCurrency(new Map()), undefined)
})

test('a paying card fits the quiet voice the operational tier demands', async () => {
  const provider = new WanderlogProvider(PRAGUE, SOURCE)
  for (const name of ['State Opera', 'St. Vitus Cathedral', 'Prague Boats']) {
    const card = await provider.draft(ask(name, 'how_to_pay'))
    if (!card) continue
    assert.deepEqual(
      checkVoice(card.body, TIER_PERSONALITY[CARD_TIER['how_to_pay']]),
      [],
      `${name}: ${card.body}`,
    )
  }
})
