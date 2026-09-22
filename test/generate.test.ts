import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EntityCache } from '../src/cache/entityCache.ts'
import { generateCards } from '../src/content/generate.ts'
import { place, leg, trip, SOURCE, StubProvider } from './helpers.ts'

const TWO_PLACES = trip(
  [place('p1', 'Sensoji Temple', 35.7148, 139.7967), place('p2', 'Tokyo Skytree', 35.7101, 139.8107)],
  [leg('l1', 'p1', 'p2', { mode: 'metro' })],
)

test('an operational card with no source is refused, not published', async () => {
  const provider = new StubProvider('unsourced', ['how_to_pay'], {
    title: 'Paying',
    body: 'Tap your card at the gate.',
    sources: [],
  })
  const { trip: out, report } = await generateCards(TWO_PLACES, { providers: [provider] })

  assert.equal(out.cards.filter((c) => c.kind === 'how_to_pay').length, 0)
  const refusal = report.refusals.find((r) => r.kind === 'how_to_pay')
  assert.ok(refusal, 'refusal recorded')
  assert.equal(refusal.tier, 'operational')
  assert.match(refusal.reason, /substantiate/)
})

test('the same operational card is published once it carries a source', async () => {
  const provider = new StubProvider('sourced', ['how_to_pay'], {
    title: 'Paying',
    body: 'Tap your card at the gate.',
    sources: [SOURCE],
  })
  const { trip: out, report } = await generateCards(TWO_PLACES, { providers: [provider] })

  const card = out.cards.find((c) => c.kind === 'how_to_pay')
  assert.ok(card)
  assert.equal(card.provenance.tier, 'operational')
  assert.equal(card.provenance.sources.length, 1)
  assert.equal(report.refusals.filter((r) => r.kind === 'how_to_pay').length, 0)
})

test('a colour card needs no source', async () => {
  const provider = new StubProvider('colour', ['history'], {
    title: 'Background',
    body: 'Founded in the seventh century.',
    sources: [],
  })
  const { trip: out } = await generateCards(TWO_PLACES, { providers: [provider] })
  assert.equal(out.cards.filter((c) => c.kind === 'history').length, 2)
})

test('a chatty operational card is rejected by the voice rules', async () => {
  const provider = new StubProvider('chatty', ['boarding'], {
    title: 'Boarding',
    body: "Let's find car three! It's an amazing spot.",
    sources: [SOURCE],
  })
  const { trip: out, report } = await generateCards(TWO_PLACES, { providers: [provider] })

  assert.equal(out.cards.filter((c) => c.kind === 'boarding').length, 0)
  assert.equal(report.voiceRejections.length, 1)
  assert.ok(report.voiceRejections[0]!.rules.includes('no-exclamation'))
})

test('a chatty colour card is allowed through, since nobody is stranded by it', async () => {
  const provider = new StubProvider('chatty', ['history'], {
    title: 'Background',
    body: 'One sentence. Two sentences. Three sentences. Four sentences.',
    sources: [],
  })
  const { trip: out, report } = await generateCards(TWO_PLACES, { providers: [provider] })
  assert.ok(out.cards.some((c) => c.kind === 'history'))
  assert.equal(report.voiceRejections.length, 0)
})

test('providers are tried in order and the first substantiated draft wins', async () => {
  const weak = new StubProvider('weak', ['how_to_pay'], { title: 'a', body: 'a', sources: [] })
  const strong = new StubProvider('strong', ['how_to_pay'], {
    title: 'Paying',
    body: 'Exact change only.',
    sources: [SOURCE],
  })
  const { trip: out } = await generateCards(TWO_PLACES, { providers: [weak, strong] })
  assert.equal(out.cards.find((c) => c.kind === 'how_to_pay')?.body, 'Exact change only.')
})

test('cards are cached against the entity so a second trip reuses them', async () => {
  const cache = await EntityCache.open()
  const provider = new StubProvider('sourced', ['how_to_pay'], {
    title: 'Paying',
    body: 'Exact change only.',
    sources: [SOURCE],
  })

  const first = await generateCards(TWO_PLACES, { providers: [provider], cache })
  assert.equal(first.report.fromCache, 0)
  assert.ok(first.report.generated > 0)

  const second = await generateCards(TWO_PLACES, { providers: [provider], cache })
  assert.ok(second.report.fromCache > 0, 'second run reads the cache')
  assert.ok(second.trip.cards.some((c) => c.provenance.cached === true))
})

test('flagging a cached card lowers its confidence and never raises it', async () => {
  const cache = await EntityCache.open()
  const provider = new StubProvider('sourced', ['how_to_pay'], {
    title: 'Paying',
    body: 'Exact change only.',
    sources: [SOURCE],
  })
  await generateCards(TWO_PLACES, { providers: [provider], cache })

  const entityKey = 'leg:metro:any:place:xx:sensoji-temple:35.715,139.797>place:xx:tokyo-skytree:35.710,139.811'
  const before = cache.get(entityKey, 'how_to_pay')
  assert.ok(before, 'card is in the cache under its entity key')
  const confidenceBefore = before.provenance.confidence

  assert.equal(cache.flag(entityKey, 'how_to_pay'), true)
  assert.ok(cache.get(entityKey, 'how_to_pay')!.provenance.confidence < confidenceBefore)
})

test('photo cards are computed for every place without a provider', async () => {
  const withBearing = trip([
    place('p1', 'Notre-Dame', 48.853, 2.3499, { facadeBearing: 270, timezone: 'Europe/Paris' }),
  ])
  const { trip: out } = await generateCards(withBearing, {
    providers: [],
    photoDate: new Date('2026-06-21T00:00:00Z'),
  })
  const photo = out.cards.find((c) => c.kind === 'photo')
  assert.ok(photo)
  assert.equal(photo.provenance.tier, 'colour')
  assert.ok(photo.provenance.sources.length > 0, 'cites the algorithm')
  assert.match(photo.body, /west-facing/)
  assert.ok(!photo.body.includes('estimated from longitude'), 'exact when a timezone is known')
})

test('a place without a timezone says its photo times are estimated', async () => {
  const noTz = trip([place('p1', 'Notre-Dame', 48.853, 2.3499, { facadeBearing: 270 })])
  const { trip: out } = await generateCards(noTz, {
    providers: [],
    photoDate: new Date('2026-06-21T00:00:00Z'),
  })
  const photo = out.cards.find((c) => c.kind === 'photo')
  assert.ok(photo)
  assert.match(photo.body, /estimated from longitude/)
  assert.ok(photo.provenance.confidence < 0.9)
})

test('a walk is not asked how it is paid for or boarded', async () => {
  // Twenty-six of Prague's twenty-nine legs are walks. Asking each of them an
  // operational question it cannot have an answer to produced fifty-two
  // refusals, and a briefing saying "Paying: not confirmed" under a
  // four-minute stroll between two palaces.
  const t = trip(
    [place('p1', 'A', 50.0, 14.4), place('p2', 'B', 50.001, 14.401)],
    [leg('l1', 'p1', 'p2', { mode: 'walk', durationMinutes: 4, distanceMetres: 300 })],
  )
  const { report } = await generateCards(t, { providers: [] })
  const kinds = report.refusals.filter((r) => r.attachesTo.kind === 'leg').map((r) => r.kind)
  assert.ok(!kinds.includes('how_to_pay'), `walks were asked about paying: ${kinds.join(', ')}`)
  assert.ok(!kinds.includes('boarding'))
})

test('a leg you board is still asked both', async () => {
  const t = trip(
    [place('p1', 'A', 50.0, 14.4), place('p2', 'B', 50.2, 14.6)],
    [leg('l1', 'p1', 'p2', { mode: 'ferry' })],
  )
  const { report } = await generateCards(t, { providers: [] })
  const kinds = report.refusals.filter((r) => r.attachesTo.kind === 'leg').map((r) => r.kind)
  assert.ok(kinds.includes('how_to_pay'), 'a ferry has a fare')
  assert.ok(kinds.includes('boarding'), 'a ferry is boarded')
})

test('a taxi is paid for but not boarded', async () => {
  const t = trip(
    [place('p1', 'A', 50.0, 14.4), place('p2', 'B', 50.05, 14.45)],
    [leg('l1', 'p1', 'p2', { mode: 'taxi' })],
  )
  const { report } = await generateCards(t, { providers: [] })
  const kinds = report.refusals.filter((r) => r.attachesTo.kind === 'leg').map((r) => r.kind)
  assert.ok(kinds.includes('how_to_pay'))
  assert.ok(!kinds.includes('boarding'))
})

test('cards are appended to the trip, not swapped in', async () => {
  // Load-bearing, and not obvious from the name: a second pass over a trip
  // that already has cards doubles them. The browser's OSM enrichment learned
  // this by shipping a briefing with ninety-four duplicates in it.
  const t = trip([place('p1', 'Sensoji Temple', 35.7148, 139.7967)])
  const once = await generateCards(t, { providers: [] })
  const twice = await generateCards(once.trip, { providers: [] })

  assert.ok(once.trip.cards.length > 0)
  assert.equal(twice.trip.cards.length, once.trip.cards.length * 2, 'the contract is append')

  // Which is why a re-run must clear them first.
  const clean = await generateCards({ ...once.trip, cards: [] }, { providers: [] })
  assert.equal(clean.trip.cards.length, once.trip.cards.length)
})
